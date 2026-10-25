// test/panel.test.js — the webview (src/panel.html, .css, .js), run in jsdom as a host loads it: a stand-in for
// acquireVsCodeApi records what the panel posts and keeps its state, and the host's messages come as `message` events
// with lists from the real buildSessions, so the panel is fed what the hosts send it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const K = require("../src/core.cjs");
const { JSDOM, VirtualConsole } = require("jsdom");

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const MIN = 60000, HOUR = 60 * MIN;
// resolved, so the registry's cwd and the workspace folder compare as native paths on Windows too
const MINE = path.resolve("/Users/me/Dev/my-project"), OTHER = path.resolve("/Users/me/Dev/other-project");

const opened = [];
afterEach(() => {
  vi.useRealTimers();
  // an exception in the panel's listeners goes to jsdom's console, not to the test: every panel must end without one
  for (const p of opened.splice(0)) { p.window.close(); expect(p.errors).toEqual([]); }
});

/**
 * The panel's page (core.cjs panelPage) loaded as extension.js loads it (the CSP, the nonce), with `state` as the
 * webview state it starts with. The page's timers are the test's, so vi.useFakeTimers() moves them. jsdom has no
 * layout and no ResizeObserver: the page gets a stand-in whose callbacks `resize()` calls, as a browser does when an
 * observed element changes size.
 * `utc`: the clock times in en-US and UTC whatever the machine's zone and locale, for a recorded DOM.
 */
function panel({ state = null, utc = false } = {}) {
  const html = K.panelPage({ nonce: "n" });
  const posted = [], errors = [], resizers = [];
  let saved = state;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  virtualConsole.on("error", (...a) => errors.push(a.join(" ")));
  const { window } = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.acquireVsCodeApi = () => ({ getState: () => saved, setState: (s) => { saved = s; }, postMessage: (m) => posted.push(m) });
      for (const name of ["setTimeout", "clearTimeout"]) w[name] = (...a) => globalThis[name](...a);
      w.ResizeObserver = class { constructor(cb) { resizers.push(cb); } observe() {} disconnect() {} };
      if (utc) { // a page Intl over the real one, so only this page's clock changes
        const Clock = w.Intl.DateTimeFormat;
        w.Intl = Object.create(w.Intl, { DateTimeFormat: { value: function (_, options) { return new Clock("en-US", { ...options, timeZone: "UTC" }); } } });
      }
    },
  });
  const doc = window.document;
  const p = {
    window, doc, posted, errors, state: () => saved,
    send: (msg) => window.dispatchEvent(new window.MessageEvent("message", { data: msg })),
    $: (id) => doc.querySelector(`[data-testid="${id}"]`),
    $$: (id) => [...doc.querySelectorAll(`[data-testid="${id}"]`)],
    rows: () => [...doc.querySelectorAll('[data-testid="list"] .kx-session')].map((r) => r.dataset.session),
    row: (id) => doc.querySelector(`[data-testid="list"] .kx-session[data-session="${id}"]`),
    fold: (group) => doc.querySelector(`[data-testid="fold"][data-group="${group}"]`),
    key: (target, key) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })),
    resize: () => resizers.forEach((cb) => cb([])),
  };
  opened.push(p);
  return p;
}

/**
 * One live session: its registry entry and its parsed transcript, as SessionReader hands them to buildSessions. Other
 * options are transcript fields (`cacheTtlMs: null`, `compactions`), over the ones made here.
 */
function session(sessionId, { tokens = 50000, status = "idle", model = "claude-opus-5-5", title = `Session ${sessionId}`, turns = 3,
  ago = MIN, startedAgo = 10 * MIN, cwd = MINE, series, name = null, ...more } = {}) {
  const all = series || Array.from({ length: turns }, (_, i) => Math.round((tokens * (i + 1)) / turns));
  return {
    registry: { pid: 1000 + sessionId.charCodeAt(0), sessionId, cwd, status, startedAt: NOW - startedAgo, name },
    transcript: {
      tokens, model, title, turns, series: all, lastTurn: new Date(NOW - ago).toISOString(),
      outputSeries: all.map(() => 400), thinkingSeries: all.map(() => 100), outputTotal: 400 * all.length, thinkingTotal: 100 * all.length,
      cacheTtlMs: HOUR, cacheRead: Math.round(tokens * 0.9), cacheCreated: 1000, compactions: [],
      baseline: all[0], baselineAt: 0, baselineCause: "start", growthBySource: { Bash: 5000, you: 1000 }, ...more,
    },
  };
}

/** The `sessions` message a host posts for these sessions (SessionReader.read's payload). */
function list(sessions, { all = false, full = false, errors = [], workspaceFolders = [] } = {}) {
  const transcripts = Object.fromEntries(sessions.map((s) => [s.registry.sessionId, s.transcript]));
  const subagents = Object.fromEntries(sessions.map((s) => [s.registry.sessionId, s.agents || []]));
  const built = K.buildSessions({ registry: sessions.map((s) => s.registry), transcripts, subagents, now: NOW, workspaceFolders, all });
  return { type: "sessions", ...built, all, full, errors, generatedAt: new Date(NOW).toISOString(), projectFolders: [] };
}

describe("panel: the list", () => {
  it("posts ready at start, and a list renders its count, its zone counts and its rows in the core's order", () => {
    const p = panel();
    expect(p.posted).toEqual([{ type: "ready" }]);
    p.send(list([
      session("d", { tokens: 140000, ago: MIN }), session("c", { tokens: 230000, ago: 2 * MIN }),
      session("b", { tokens: 170000, status: "waiting" }), session("a", { tokens: 50000, status: "busy" }),
    ]));
    expect(p.$("count").textContent).toBe("4");
    expect(p.$$("zone-yellow")).toHaveLength(0);
    expect(["green", "orange", "red"].map((z) => p.$(`zone-${z}`).textContent)).toEqual(["2", "1", "1"]);
    expect(p.rows()).toEqual(["a", "b", "d", "c"]); // busy, waiting, then the last turn newest first
    expect(p.$$("fold").map((b) => b.dataset.group)).toEqual(["busy", "waiting", "idle"]);
    expect(p.row("c").dataset.zone).toBe("red");
  });

  it("the panel shows the core's tokensText, around 1 000 and 1 000 000 too, and has no copy of its own", () => {
    expect(readFileSync(path.join(path.dirname(require.resolve("../src/core.cjs")), "panel.js"), "utf8")).not.toMatch(/function tokensText|tokensText =/);
    const counts = [0, 850, 999, 1000, 1499, 1500, 43000, 999499, 999500, 1000000, 1234567, 25000000];
    const p = panel();
    p.send(list(counts.map((tokens, i) => session(String.fromCharCode(65 + i), { tokens }))));
    for (const [i, tokens] of counts.entries()) {
      expect(p.row(String.fromCharCode(65 + i)).querySelector('[data-testid="tokens"]').textContent).toBe(K.tokensText(tokens));
    }
  });

  it("the sort orders the rows inside each group, busy stays first, and the view is kept in the state", () => {
    const p = panel();
    const sessions = [session("a", { tokens: 20000, ago: MIN }), session("b", { tokens: 90000, ago: 2 * MIN }),
      session("c", { tokens: 60000, ago: 3 * MIN }), session("z", { tokens: 10000, status: "busy" })];
    p.send(list(sessions));
    expect(p.rows()).toEqual(["z", "a", "b", "c"]);
    p.$("sort").value = "size";
    p.$("sort").dispatchEvent(new p.window.Event("change"));
    expect(p.rows()).toEqual(["z", "b", "c", "a"]);
    expect(p.state().view.sort).toBe("size");
    const again = panel({ state: p.state() });
    again.send(list(sessions));
    expect(again.$("sort").value).toBe("size");
    expect(again.rows()).toEqual(["z", "b", "c", "a"]);
  });

  it("orange and red only hides the other idle sessions, never a busy or waiting one, and reset brings them back", () => {
    const p = panel();
    p.send(list([session("g", { tokens: 20000 }), session("o", { tokens: 170000 }), session("r", { tokens: 230000 }),
      session("b", { tokens: 20000, status: "busy" }), session("w", { tokens: 20000, status: "waiting" })]));
    expect(p.$("reset").hidden).toBe(true);
    p.$("filter-hot").click();
    expect(p.$("filter-hot").getAttribute("aria-pressed")).toBe("true");
    expect(p.rows().sort()).toEqual(["b", "o", "r", "w"]);
    expect(p.fold("idle").querySelector(".kx-gn").textContent).toBe("· 2 of 3");
    expect(p.$("showing").hidden).toBe(false);
    expect(p.$("showing").textContent).toBe("showing 4 of 5");
    expect(p.$("reset").hidden).toBe(false);
    p.$("reset").click();
    expect(p.rows().sort()).toEqual(["b", "g", "o", "r", "w"]);
    expect(p.$("reset").hidden).toBe(true);
    expect(p.$("showing").hidden).toBe(true);
  });

  it("a model chip hides that model's idle sessions; the chips show only with two models or more", () => {
    const p = panel();
    p.send(list([session("a"), session("b")]));
    expect(p.$("models").hidden).toBe(true);
    p.send(list([session("a"), session("s", { model: "claude-sonnet-5-5" }), session("t", { model: "claude-sonnet-5-5", status: "busy" })]));
    expect(p.$("models").hidden).toBe(false);
    expect(p.$$("filter-model").map((c) => c.dataset.model)).toEqual(["Opus 5.5", "Sonnet 5.5"]);
    p.$$("filter-model")[1].click();
    expect(p.rows().sort()).toEqual(["a", "t"]);
    expect(p.$$("filter-model")[1].getAttribute("aria-pressed")).toBe("false");
    expect(p.state().view.hiddenModels).toEqual(["Sonnet 5.5"]);
  });

  it("the abandoned group starts folded, and a fold is remembered", () => {
    const sessions = [session("a"), session("old", { ago: 2 * HOUR, startedAgo: 3 * HOUR })];
    const p = panel();
    p.send(list(sessions));
    expect(p.fold("abandoned").getAttribute("aria-expanded")).toBe("false");
    expect(p.rows()).toEqual(["a"]);
    p.fold("abandoned").click();
    expect(p.rows()).toEqual(["a", "old"]);
    expect(p.doc.activeElement).toBe(p.fold("abandoned")); // the button is kept, and the focus stays on it
    p.fold("idle").click();
    expect(p.rows()).toEqual(["old"]);
    expect(p.state()).toMatchObject({ folded: ["idle"], unfolded: ["abandoned"] });
    const again = panel({ state: p.state() });
    again.send(list(sessions));
    expect(again.rows()).toEqual(["old"]);
  });

  it("compact rows are switched by their button and remembered", () => {
    const p = panel();
    p.$("compact").click();
    expect(p.$("list").hasAttribute("data-compact")).toBe(true);
    expect(p.$("compact").getAttribute("aria-pressed")).toBe("true");
    expect(panel({ state: p.state() }).$("list").hasAttribute("data-compact")).toBe(true);
  });

  it("errors are shown, and a title with markup is shown as text", () => {
    const p = panel();
    const title = '<img src=x onerror="alert(1)"><b>bold</b>';
    p.send(list([session("a", { title })], { errors: ["Project folder not found: /x"] }));
    expect(p.$("errors").hidden).toBe(false);
    expect([...p.$("errors").querySelectorAll(".kx-error")].map((e) => e.textContent)).toEqual(["Project folder not found: /x"]);
    expect(p.row("a").querySelector(".kx-title").textContent).toBe(title);
    expect(p.doc.querySelector("img, b.bold")).toBeNull();
    expect(p.$("list").querySelector("b")).toBeNull();
    p.send(list([session("a")]));
    expect(p.$("errors").hidden).toBe(true);
  });

  it("a list without sessions says so", () => {
    const p = panel();
    p.send(list([]));
    expect(p.$("count").textContent).toBe("0");
    expect(p.$("list").textContent).toBe("No live Claude sessions");
  });
});

describe("panel: lists update in place", () => {
  it("a second list keeps a row's elements, its bar and the zone counts, with the new text, widths and titles", () => {
    const p = panel();
    p.send(list([session("a", { tokens: 100000 }), session("b", { tokens: 170000, ago: 2 * MIN })]));
    const row = p.row("a"), bar = row.querySelector('[data-testid="bar"]'), fill = bar.querySelector(".kx-fill");
    const parts = [bar, fill, ...["tokens", "curve", "output", "growth", "cache"].map((id) => row.querySelector(`[data-testid="${id}"]`))];
    const counters = ["zone-green", "zone-orange", "zone-red", "count", "cache-warm"].map((id) => p.$(id));
    const greenItem = p.$("zone-green").parentNode;
    p.send(list([session("a", { tokens: 160000 }), session("b", { tokens: 170000, ago: 2 * MIN })]));
    expect(p.row("a")).toBe(row);
    const after = [bar, fill, ...["tokens", "curve", "output", "growth", "cache"].map((id) => row.querySelector(`[data-testid="${id}"]`))];
    for (const [i, e] of after.entries()) expect(e, `part ${i}`).toBe(parts[i]);
    for (const [i, id] of ["zone-green", "zone-orange", "zone-red", "count", "cache-warm"].entries()) expect(p.$(id)).toBe(counters[i]);
    expect(row.querySelector('[data-testid="tokens"]').textContent).toBe("160K");
    expect(fill.style.getPropertyValue("--p")).toBe("53.33");
    expect(bar.title).toMatch(/^160K tokens in the context.*· Break at the next phase boundary/);
    expect(row.dataset.zone).toBe("orange");
    expect(row.style.getPropertyValue("--kx-zone-fill")).toBe("var(--kx-orange-fill)");
    expect(["green", "orange", "red"].map((z) => p.$(`zone-${z}`).textContent)).toEqual(["0", "2", "0"]);
    expect(greenItem.title).toMatch(/^0 of the 2 sessions .* are in the green zone$/);
  });

  it("a gone session loses its row, a new one gets a row in the core's order, and one that went busy moves to Working now", () => {
    const p = panel();
    p.send(list([session("a", { ago: MIN }), session("b", { ago: 2 * MIN }), session("c", { ago: 3 * MIN })]));
    expect(p.rows()).toEqual(["a", "b", "c"]);
    const b = p.row("b"), c = p.row("c");
    b.focus();
    const next = [session("b", { status: "busy", ago: 2 * MIN }), session("c", { ago: 3 * MIN }), session("d", { ago: 30000 })];
    p.send(list(next));
    expect(p.rows()).toEqual(["b", "d", "c"]);
    expect(p.row("a")).toBeNull();
    expect(p.row("b")).toBe(b);
    expect(p.row("c")).toBe(c);
    expect(b.closest(".kx-rows").id).toBe("kx-rows-busy");
    expect(b.querySelector(".kx-badge").textContent).toBe("busy");
    expect(p.$$("fold").map((f) => f.dataset.group)).toEqual(["busy", "idle"]);
    expect(p.doc.activeElement).toBe(b); // it moved, and kept the focus
    // with all projects the rows go under a project heading, still the same nodes
    p.send(list(next, { all: true, workspaceFolders: [MINE] }));
    expect(p.row("b")).toBe(b);
    expect(p.row("c")).toBe(c);
    expect(b.closest(".kx-rows").id).toBe("kx-rows-my-project_2f_busy");
  });

  it("a row that leaves takes only itself out: the rows after it are never out of the document", () => {
    const p = panel();
    p.send(list([session("a", { ago: MIN }), session("b", { ago: 2 * MIN }), session("c", { ago: 3 * MIN })]));
    const rows = p.row("b").parentNode;
    const seen = new p.window.MutationObserver(() => {});
    seen.observe(rows, { childList: true });
    p.send(list([session("b", { ago: 2 * MIN }), session("c", { ago: 3 * MIN }), session("old", { ago: 2 * HOUR, startedAgo: 3 * HOUR })]));
    expect(p.rows()).toEqual(["b", "c"]); // "old" is in the folded idle-over-an-hour group
    const records = seen.takeRecords();
    expect(records.flatMap((r) => [...r.removedNodes]).map((n) => n.dataset.session)).toEqual(["a"]);
    expect(records.flatMap((r) => [...r.addedNodes])).toEqual([]);
  });

  it("an unchanged row is not touched, a changed one is patched alone, and its since text still moves", () => {
    const p = panel();
    const at = (tokens, ago) => [session("a", { tokens, ago }), session("b", { ago: 2 * MIN }), session("c", { ago: 3 * MIN })];
    p.send(list(at(50000, MIN)));
    const rows = ["a", "b", "c"].map((id) => p.row(id));
    const seen = new p.window.MutationObserver(() => {});
    seen.observe(p.$("list"), { subtree: true, childList: true, attributes: true, characterData: true });
    // the rows the panel builds: every element it makes, the rows among them
    const made = [], create = p.doc.createElement.bind(p.doc);
    p.doc.createElement = (...a) => { const e = create(...a); made.push(e); return e; };
    const built = () => made.splice(0).filter((e) => e.classList.contains("kx-session")).length;
    p.send(list(at(50000, MIN)));
    expect(built()).toBe(0);
    expect(seen.takeRecords()).toEqual([]);
    expect(["a", "b", "c"].map((id) => p.row(id))).toEqual(rows);
    expect(p.row("b").querySelector('[data-testid="tokens"]').textContent).toBe("50K"); // the live row, not a placeholder
    p.send(list(at(120000, MIN)));
    expect(built()).toBe(1);
    const touched = seen.takeRecords().map((r) => (r.target.nodeType === 1 ? r.target : r.target.parentElement).closest(".kx-session")?.dataset.session);
    expect(touched.length).toBeGreaterThan(0);
    expect(new Set(touched)).toEqual(new Set(["a"]));
    expect(p.row("a").querySelector('[data-testid="tokens"]').textContent).toBe("120K");
    const since = () => [...p.row("a").querySelectorAll(".kx-meta span")].map((s) => s.textContent).find((t) => / ago$/.test(t));
    expect(since()).toBe("1 min ago");
    p.send(list(at(120000, 2 * MIN)));
    expect(since()).toBe("2 min ago");
    expect(p.row("a")).toBe(rows[0]);
  });

  it("two processes of one session keep two full rows through an identical list", () => {
    const one = session("a"), two = { ...session("a"), registry: { ...session("a").registry, pid: 2000 } };
    const p = panel();
    p.send(list([one, two, session("b", { ago: 2 * MIN })]));
    p.send(list([one, two, session("b", { ago: 2 * MIN })]));
    expect(p.rows()).toEqual(["a", "a", "b"]);
    for (const row of p.doc.querySelectorAll('[data-testid="list"] .kx-session')) {
      expect(row.hasAttribute("data-kept")).toBe(false);
      expect(row.querySelector('[data-testid="tokens"]')).not.toBeNull();
    }
  });

  it("the scope line and the model chips keep their text and titles through an identical list", () => {
    const p = panel();
    const sessions = [session("a"), session("s", { model: "claude-sonnet-5-5" }), session("o", { cwd: OTHER })];
    p.send(list(sessions, { workspaceFolders: [MINE] }));
    const parts = [p.$("scope-name").firstChild, p.$("scope-more").firstChild, ...p.$$("filter-model").map((c) => c.firstChild)];
    const seen = new p.window.MutationObserver(() => {});
    for (const e of [p.$("scope-name"), p.$("scope-more"), p.$("models")]) seen.observe(e, { subtree: true, childList: true, characterData: true, attributeFilter: ["title"] });
    p.send(list(sessions, { workspaceFolders: [MINE] }));
    expect(seen.takeRecords()).toEqual([]);
    expect([p.$("scope-name").firstChild, p.$("scope-more").firstChild, ...p.$$("filter-model").map((c) => c.firstChild)]).toEqual(parts);
    expect(p.$("scope-name").title).toBe("The sessions started inside the workspace folder my-project");
  });

  it("a project named like a group gets ids and keys of its own", () => {
    const p = panel();
    const one = session("a", { cwd: path.join(path.sep, "dev", "busy") }), two = session("b", { status: "busy", cwd: path.join(path.sep, "dev", "project") });
    p.send(list([one, two], { all: true }));
    const ids = [...p.doc.querySelectorAll(".kx-rows")].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const [a, b] = [p.row("a"), p.row("b")];
    p.send(list([one, two], { all: true }));
    expect([p.row("a") === a, p.row("b") === b]).toEqual([true, true]);
  });

  it("the focus on a row survives a list, and folding, the sort, the filters and compact rows give the rows they gave", () => {
    const p = panel();
    const at = (tokens) => [session("a", { tokens: tokens[0], ago: MIN }), session("b", { tokens: tokens[1], ago: 2 * MIN }), session("c", { tokens: tokens[2], ago: 3 * MIN })];
    p.send(list(at([50000, 170000, 230000])));
    p.row("b").focus();
    p.send(list(at([52000, 171000, 231000])));
    expect(p.doc.activeElement).toBe(p.row("b"));
    p.$("sort").value = "size";
    p.$("sort").dispatchEvent(new p.window.Event("change"));
    expect(p.rows()).toEqual(["c", "b", "a"]);
    p.send(list(at([52000, 240000, 231000])));
    expect(p.rows()).toEqual(["b", "c", "a"]);
    p.$("filter-hot").click();
    expect(p.rows()).toEqual(["b", "c"]);
    p.$("reset").click();
    expect(p.rows()).toEqual(["a", "b", "c"]);
    p.$("compact").click();
    p.send(list(at([52000, 240000, 231000])));
    expect(p.rows()).toEqual(["a", "b", "c"]);
    p.fold("idle").click();
    expect(p.rows()).toEqual([]);
    expect(p.fold("idle").getAttribute("aria-expanded")).toBe("false");
    p.fold("idle").click();
    expect(p.rows()).toEqual(["a", "b", "c"]);
  });
});

describe("panel: the zone scale", () => {
  it("draws the zones at their true widths on 0–300K with each range inside, and says what applies in each", () => {
    const p = panel();
    p.send(list([session("a")]));
    const bands = ["green", "orange", "red"].map((z) => p.$(`band-${z}`));
    expect(p.$("zone-scale").children).toHaveLength(3);
    expect(bands.map((b) => b.style.getPropertyValue("--w"))).toEqual(["50", "16.67", "33.33"]);
    expect(bands.map((b) => b.querySelector(".kx-zlong").textContent)).toEqual(["below 150K", "150K–200K", "above 200K"]);
    expect(bands.map((b) => b.querySelector(".kx-zshort").textContent)).toEqual(["<150K", "150K+", ">200K"]);
    expect(p.$("band-green").title).toBe("green zone: below 150K");
    expect(p.$("band-orange").title).toBe("orange zone: 150K–200K · Break at the next phase boundary; continue only if the next phase needs this one verbatim.");
    expect(p.$("band-red").title).toMatch(/^red zone: above 200K · Do not start a new phase/);
  });

  it("is the same with no sessions, and one image to assistive technology, its label naming the limits", () => {
    const p = panel();
    p.send(list([]));
    expect(p.$$("band-green")).toHaveLength(1);
    expect(p.$("zone-scale").getAttribute("role")).toBe("img");
    expect(p.$("zone-scale").getAttribute("aria-label")).toBe(
      "Zones on a 0–300K scale: green below 150K, orange 150K–200K and red above 200K");
  });

  it("keeps the count per zone beside the session count, for the scope", () => {
    const p = panel();
    const mine = session("a", { tokens: 39000 }), other = session("b", { tokens: 170000, cwd: OTHER });
    p.send(list([mine, other], { workspaceFolders: [MINE] }));
    expect(["green", "orange"].map((z) => p.$(`zone-${z}`).textContent)).toEqual(["1", "0"]);
    p.send(list([mine, other], { workspaceFolders: [MINE], all: true }));
    expect(["green", "orange"].map((z) => p.$(`zone-${z}`).textContent)).toEqual(["1", "1"]);
  });

  it("takes the limits from the core's zones: other limits move the bands and the rows' marks", () => {
    const p = panel();
    const ticks = () => [...p.row("a").querySelectorAll(".kx-tick")].map((t) => t.style.getPropertyValue("--t"));
    p.send(list([session("a")]));
    expect(ticks()).toEqual(["50", "66.67"]);
    const built = list([session("a")]);
    const bounds = [[0, 90000], [90000, 210000], [210000, null]];
    p.send({ ...built, zones: built.zones.map((z, i) => ({ ...z, from: bounds[i][0], to: bounds[i][1] })) });
    expect(["green", "orange", "red"].map((z) => p.$(`band-${z}`).style.getPropertyValue("--w"))).toEqual(["30", "40", "30"]);
    expect(ticks()).toEqual(["30", "70"]);
  });

  it("runs the row bar 0–300K with marks at 150K and 200K: only a count above 300K gets the hatched end", () => {
    const p = panel();
    p.send(list([session("a", { tokens: 250000 }), session("b", { tokens: 300000 }), session("c", { tokens: 320000 })]));
    const bar = (id) => p.row(id).querySelector('[data-testid="bar"]');
    expect(bar("a").title).toMatch(/· scale 0–300K, marks at 150K and 200K/);
    expect(["a", "b", "c"].map((id) => bar(id).querySelector(".kx-over") !== null)).toEqual([false, false, true]);
    expect(["a", "b", "c"].map((id) => bar(id).getAttribute("aria-label"))).toEqual(["83 % of the 300K scale", "100 % of the 300K scale", "over the 300K scale"]);
  });

  it("before any zones, draws no limits and names none, in the rows and the detail view", () => {
    const p = panel();
    p.send({ ...list([session("a")]), zones: undefined });
    expect(p.$$("band-green")).toHaveLength(0);
    expect(p.row("a").querySelectorAll(".kx-tick")).toHaveLength(0);
    expect(p.row("a").querySelector('[data-testid="bar"]').title).not.toMatch(/marks at/);
    p.row("a").click();
    expect(p.$("detail").innerHTML).not.toMatch(/NaN|undefined/);
    expect(p.$("detail").textContent).not.toMatch(/Zones warn about quality at/);
    expect(p.errors).toEqual([]);
  });

  it("ignores zones out of order or beyond the scale", () => {
    const p = panel();
    p.send(list([session("a")]));
    const built = list([session("a")]);
    p.send({ ...built, zones: [built.zones[1], built.zones[0], ...built.zones.slice(2)] });
    p.send({ ...built, zones: built.zones.map((z, i) => (i === 2 ? { ...z, from: 350000 } : z)) });
    expect(p.$("band-red").style.getPropertyValue("--w")).toBe("33.33");
  });

  it("builds the bands once for the same zones, so a band's tooltip survives the next list; a list without zones keeps them", () => {
    const p = panel();
    p.send(list([session("a")]));
    const band = p.$("band-orange");
    p.send(list([session("a", { tokens: 120000 })]));
    expect(p.$("band-orange")).toBe(band);
    p.send({ ...list([session("a")]), zones: undefined });
    expect(p.$("band-orange")).toBe(band);
    expect(p.row("a").querySelectorAll(".kx-tick")).toHaveLength(2);
  });

  it("shows a band's long range when it fits, else the short one, else none, never a clipped label", () => {
    const p = panel();
    p.send(list([session("a")]));
    // jsdom has no layout: each band is given a width, and its content the width of the text it shows
    const widths = { green: [160, 80, 40], orange: [20, 68, 34], red: [20, 68, 24] };
    for (const [z, [client, long, short]] of Object.entries(widths)) {
      const band = p.$(`band-${z}`);
      Object.defineProperty(band, "clientWidth", { value: client, configurable: true });
      Object.defineProperty(band, "scrollWidth", { get: () => ({ long, short, none: 0 })[band.dataset.fit] });
    }
    p.resize();
    expect(["green", "orange", "red"].map((z) => p.$(`band-${z}`).dataset.fit)).toEqual(["long", "none", "none"]);
    Object.defineProperty(p.$("band-orange"), "clientWidth", { value: 40 });
    p.send(list([session("a")])); // a list does not measure again: each try forces a layout
    expect(p.$("band-orange").dataset.fit).toBe("none");
    p.resize();
    expect(p.$("band-orange").dataset.fit).toBe("short");
  });
});

describe("panel: the scope", () => {
  it("the buttons post scope, and the pressed one follows at once", () => {
    const p = panel();
    p.send(list([session("a")]));
    p.$("scope-all").click();
    expect(p.posted.at(-1)).toEqual({ type: "scope", all: true });
    expect(p.$("scope-all").getAttribute("aria-pressed")).toBe("true");
    expect(p.$("scope-workspace").getAttribute("aria-pressed")).toBe("false");
    p.$("scope-all").click(); // already pressed: nothing new is posted
    expect(p.posted.filter((m) => m.type === "scope")).toHaveLength(1);
    p.$("scope-workspace").click();
    expect(p.posted.at(-1)).toEqual({ type: "scope", all: false });
  });

  it("names the workspace folder, and \"N more in other projects\" switches to all projects", () => {
    const p = panel();
    p.send(list([session("a"), session("b", { cwd: OTHER }), session("c", { cwd: OTHER })], { workspaceFolders: [MINE] }));
    expect(p.rows()).toEqual(["a"]);
    expect(p.$("scope-name").hidden).toBe(false);
    expect(p.$("scope-name").textContent).toBe("my-project");
    expect(p.$("scope-more").hidden).toBe(false);
    expect(p.$("scope-more").textContent).toBe("2 more in other projects");
    p.$("scope-more").click();
    expect(p.posted.at(-1)).toEqual({ type: "scope", all: true });
  });

  it("all projects groups the rows by project, each with its own fold", () => {
    const p = panel();
    p.send(list([session("a"), session("b", { cwd: OTHER })], { all: true }));
    expect(p.$$("fold").map((b) => b.dataset.group)).toEqual(["project:my-project", "idle", "project:other-project", "idle"]);
    expect(p.$("scope-name").hidden).toBe(true);
    p.fold("project:other-project").click();
    expect(p.rows()).toEqual(["a"]);
  });
});

describe("panel: the refresh button", () => {
  it("posts refresh, and only a list with full: true takes the receipt", () => {
    const p = panel();
    p.send(list([session("a")]));
    p.$("refresh").click();
    expect(p.posted.at(-1)).toEqual({ type: "refresh" });
    expect(p.$("refresh").getAttribute("aria-busy")).toBe("true");
    p.$("refresh").click(); // pending: not posted twice
    expect(p.posted.filter((m) => m.type === "refresh")).toHaveLength(1);
    p.send(list([session("a")])); // a watcher's list already on its way
    expect(p.$("refresh").getAttribute("aria-busy")).toBe("true");
    expect(p.$("refreshed").hidden).toBe(true);
    p.send(list([session("a")], { full: true }));
    expect(p.$("refresh").hasAttribute("aria-busy")).toBe(false);
    expect(p.$("refreshed").hidden).toBe(false);
    expect(p.$("refreshed").textContent).toMatch(/^updated /);
  });

  it("gives up after 15 seconds without an answer, and hides the receipt after 4", () => {
    vi.useFakeTimers();
    const p = panel();
    p.$("refresh").click();
    vi.advanceTimersByTime(14999);
    expect(p.$("refresh").getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(1);
    expect(p.$("refresh").hasAttribute("aria-busy")).toBe(false);
    p.$("refresh").click();
    expect(p.posted.filter((m) => m.type === "refresh")).toHaveLength(2);
    p.send(list([session("a")], { full: true }));
    expect(p.$("refreshed").hidden).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(p.$("refreshed").hidden).toBe(true);
  });
});

/**
 * A session's subagents as SessionReader reads them (core.cjs readSubagents): per subagent its meta file, its parsed
 * transcript and its last write. Ends are recorded by `finished` only; one without it was written a minute ago, so it runs.
 */
function agents(list) {
  return list.map(([agentId, tokens, { finished = true, ago = 5 * MIN, type = "Explore", description = `Task ${agentId}` } = {}]) => ({
    agentId, writtenMs: NOW - MIN,
    meta: { agentType: type, description, spawnDepth: 1, finished: finished || null },
    state: { tokens, turns: 4, model: "claude-haiku-5-5", outputTotal: 2000, lastTurn: new Date(NOW - ago).toISOString() },
  }));
}
/** The detail answer for one session (SessionReader.detail), with its subagents' rows. */
const detailOf = (s) => ({ type: "detail", sessionId: s.registry.sessionId,
  detail: { turns: s.transcript.turns, ...K.seriesFor(s.transcript), subagentList: K.subagentRows(s.agents, { ends: [], startedMs: s.registry.startedAt, now: NOW }) } });

describe("panel: subagents", () => {
  it("the subagent table's running badge has the class and the icon of a row's busy badge", () => {
    const a = { ...session("a", { status: "busy" }), agents: agents([["x1", 90000, { finished: false }], ["x2", 40000]]) };
    const p = panel();
    p.send(list([a]));
    const busy = p.row("a").querySelector(".kx-badge");
    p.row("a").click();
    p.send(detailOf(a));
    const running = p.$$("subagent").map((r) => r.querySelector(".kx-badge")).filter(Boolean);
    expect(running.map((b) => b.textContent)).toEqual(["running"]);
    expect([busy.textContent, running[0].className, running[0].querySelector("svg").outerHTML]).toEqual(["busy", busy.className, busy.querySelector("svg").outerHTML]);
  });

  it("a row shows the mark only with subagents, with the running count, in the colour of the highest zone when it is orange or red", () => {
    const p = panel();
    p.send(list([
      { ...session("a"), agents: agents([["x1", 40000], ["x2", 230000, { description: "Find the slow query" }], ["x3", 90000, { finished: false }]]) },
      { ...session("b", { ago: 2 * MIN }), agents: agents([["y1", 160000, { finished: false }]]) },
      { ...session("c", { ago: 3 * MIN }), agents: agents([["z1", 30000]]) },
      session("d", { ago: 4 * MIN }),
    ]));
    const mark = (id) => p.row(id).querySelector('[data-testid="subagents"]');
    expect(mark("a").textContent).toBe("3 subagents · 1 running");
    expect(mark("a").dataset.zone).toBe("red");
    expect(mark("a").title).toMatch(/^Subagents: 3, 1 running · largest: Explore "Find the slow query" at 230K, red zone · A subagent has a context window of its own/);
    expect(mark("b").textContent).toBe("1 subagent · 1 running");
    expect(mark("b").dataset.zone).toBe("orange");
    expect(mark("c").textContent).toBe("1 subagent");
    expect(mark("c").dataset.zone).toBe("green");
    expect(mark("d")).toBeNull();
    expect(p.row("a").dataset.zone).toBe("green"); // the session's own zone: a subagent's count is not the session's
  });

  it("the detail view lists them under the context box, above the curve, in the core's order, running first, with their zones, and says why they are separate", () => {
    const a = { ...session("a"), agents: agents([["x1", 40000, { ago: 9 * MIN }], ["x2", 230000, { ago: 2 * MIN }], ["x3", 160000, { finished: false, ago: 20 * MIN }], ["x4", null, { ago: 30 * MIN }]]) };
    const p = panel();
    p.send(list([a]));
    p.row("a").click();
    expect(p.$("detail-subagents")).toBeNull(); // the rows come with the detail answer
    p.send(detailOf(a));
    const section = p.$("detail-subagents");
    expect(section.previousElementSibling).toBe(p.$("detail-named")); // the context box, then its named facts
    expect(section.nextElementSibling.contains(p.$("detail-curve"))).toBe(true);
    expect(section.textContent).toMatch(/A subagent has a context window of its own; what returns to this session is its report, counted under "Agent"\./);
    const rows = p.$$("subagent");
    expect(rows.map((r) => [r.querySelector(".kx-d-a-who").textContent, r.dataset.status, r.dataset.zone])).toEqual([
      ["Explore Task x3", "running", "orange"], ["Explore Task x2", "finished", "red"], ["Explore Task x1", "finished", "green"], ["Explore Task x4", "finished", "unknown"],
    ]);
    expect(rows.map((r) => r.querySelector('[data-testid="subagent-tokens"]').textContent)).toEqual(["160K", "230K", "40K", "—"]);
    expect(rows[1].querySelector(".kx-fill").style.getPropertyValue("--p")).toBe(String(Math.round((230000 / 300000) * 10000) / 100));
    expect(rows[0].textContent).toMatch(/running.*4 turns.*2K out.*Haiku 5\.5.*20 min ago/);
  });

  it("a session without subagents has no mark and no subagents section", () => {
    const a = session("a");
    const p = panel();
    p.send(list([a]));
    expect(p.$("subagents")).toBeNull();
    p.row("a").click();
    p.send(detailOf({ ...a, agents: [] }));
    expect(p.$("detail-facts")).not.toBeNull();
    expect(p.$("detail-subagents")).toBeNull();
  });
});

describe("panel: the detail view", () => {
  it("opens on a click, asks for detail, and goes back on Escape with the focus on its row", () => {
    const p = panel();
    p.send(list([session("a"), session("b", { ago: 2 * MIN })]));
    p.row("b").click();
    expect(p.posted.at(-1)).toEqual({ type: "detail", sessionId: "b" });
    expect(p.$("detail").hidden).toBe(false);
    expect(p.$("list").hidden).toBe(true);
    expect(p.$("detail-title").textContent).toBe("Session b");
    expect(p.doc.activeElement).toBe(p.$("detail-back"));
    expect(p.state().open).toBe("b");
    p.key(p.doc.activeElement, "Escape");
    expect(p.$("detail").hidden).toBe(true);
    expect(p.$("list").hidden).toBe(false);
    expect(p.doc.activeElement).toBe(p.row("b"));
    expect(p.state().open).toBeNull();
  });

  it("opens on Enter and on Space, and the back button returns to the list", () => {
    const p = panel();
    p.send(list([session("a")]));
    p.key(p.row("a"), "Enter");
    expect(p.$("detail").hidden).toBe(false);
    p.$("detail-back").click();
    expect(p.$("detail").hidden).toBe(true);
    p.key(p.row("a"), " ");
    expect(p.$("detail").hidden).toBe(false);
  });

  it("shows the list's last 200 turns until the answer comes, then every turn of it", () => {
    const transcript = session("a", { tokens: 90000, turns: 300 });
    const p = panel();
    p.send(list([transcript]));
    p.row("a").click();
    expect(p.$("detail-curve-label").textContent).toMatch(/^Tokens per turn · last 200 of 300 turns · /);
    p.send({ type: "detail", sessionId: "other", detail: { turns: 9, ...K.seriesFor({ series: [1, 2] }) } }); // not the open session
    expect(p.$("detail-curve-label").textContent).toMatch(/last 200 of 300 turns/);
    p.send({ type: "detail", sessionId: "a", detail: { turns: 300, ...K.seriesFor(transcript.transcript) } });
    expect(p.$("detail-curve-label").textContent).toMatch(/^Tokens per turn · 300 turns · /);
    expect(p.$("detail-curve").querySelector("svg").getAttribute("data-points")).toBe("300");
    expect(p.$("detail-turn").max).toBe("300");
  });

  it("asks for detail again with every list while open, and says when the session is gone", () => {
    const p = panel();
    p.send(list([session("a"), session("b")]));
    p.row("a").click();
    p.send(list([session("a"), session("b")]));
    expect(p.posted.filter((m) => m.type === "detail")).toHaveLength(2);
    p.send(list([session("b")]));
    expect(p.$("detail-gone").textContent).toBe("That session is gone from the registry.");
    p.$("detail-back").click();
    expect(p.rows()).toEqual(["b"]);
  });

  it("opens the session that was open when the panel was last shown", () => {
    const p = panel({ state: { open: "a" } });
    expect(p.$("list").hidden).toBe(true);
    p.send(list([session("a")]));
    expect(p.$("detail-title").textContent).toBe("Session a");
    expect(p.posted.at(-1)).toEqual({ type: "detail", sessionId: "a" });
  });

  it("labels the curve's axis at 150K and 200K when there is room, else only at 200K, never overlapping", () => {
    const p = panel();
    const axis = () => {
      const field = p.$("detail-curve");
      const labels = [...field.querySelectorAll(".kx-d-axis")];
      return { narrow: field.dataset.axis, wide: field.dataset.axisWide, labels: labels.map((a) => a.textContent),
        low: labels.filter((a) => a.classList.contains("kx-d-axis-low")).map((a) => a.textContent),
        // jsdom applies the style but not its media query, so this is the narrow field's rule
        shown: labels.filter((a) => p.window.getComputedStyle(a).display !== "none").map((a) => a.textContent) };
    };
    p.send(list([session("a", { series: [30000, 120000, 250000] })]));
    p.row("a").click();
    // 0–300K: the limits are 50K apart, 25 px in the 150 px field
    expect(axis()).toEqual({ narrow: "2", wide: "2", labels: ["150K", "200K", "300K"], low: ["150K"], shown: ["150K", "200K", "300K"] });
    // 0–900K: 8 px apart in the 150 px field, so 150K is hidden there; 12 px in the 220 px one, so both stay
    p.send(list([session("a", { series: [30000, 400000, 900000] })]));
    expect(axis()).toEqual({ narrow: "1", wide: "2", labels: ["150K", "200K", "900K"], low: ["150K"], shown: ["200K", "900K"] });
    p.send(list([session("a", { series: [30000, 900000, 2000000] })]));
    expect(axis()).toMatchObject({ narrow: "1", wide: "1", low: ["150K"], shown: ["200K", "2.0M"] });
  });

  it("leaves the list alone while it is open, and the way back shows the last list", () => {
    const p = panel();
    p.send(list([session("a"), session("b", { ago: 2 * MIN })]));
    p.row("a").click();
    const seen = new p.window.MutationObserver(() => {});
    seen.observe(p.$("list"), { subtree: true, childList: true, attributes: true, characterData: true });
    p.send(list([session("a", { tokens: 120000 }), session("c", { ago: 3 * MIN })]));
    expect(seen.takeRecords()).toEqual([]);
    p.$("detail-back").click();
    expect(p.rows()).toEqual(["a", "c"]);
    expect(p.row("a").querySelector('[data-testid="tokens"]').textContent).toBe("120K");
    expect(p.doc.activeElement).toBe(p.row("a"));
  });

  it("on the way back a moved row's bar is set to its new width once, not slid from the width it had", () => {
    const p = panel();
    p.send(list([session("a"), session("b", { tokens: 50000, ago: 2 * MIN })]));
    p.row("a").click();
    p.send(list([session("a"), session("b", { tokens: 120000, status: "busy" })])); // b moves to Working now
    const fill = p.row("b").querySelector(".kx-fill");
    const seen = new p.window.MutationObserver(() => {});
    seen.observe(fill, { attributes: true, attributeFilter: ["style"] });
    p.$("detail-back").click();
    expect(p.row("b").closest(".kx-rows").id).toBe("kx-rows-busy");
    expect(seen.takeRecords()).toHaveLength(1);
    expect(fill.style.getPropertyValue("--p")).toBe("40");
  });

  it("says the session is gone at once, also after an answer has come", () => {
    const one = session("a");
    const p = panel();
    p.send(list([one, session("b")]));
    p.row("a").click();
    p.send({ type: "detail", sessionId: "a", detail: { turns: 3, ...K.seriesFor(one.transcript) } });
    p.send(list([session("b")]));
    expect(p.$("detail-gone").textContent).toBe("That session is gone from the registry.");
  });

  it("draws once per list, from its answer, and keeps its elements, so their tooltips stay open", () => {
    const one = session("a", { tokens: 90000, turns: 5 }), two = session("a", { tokens: 120000, turns: 6 });
    const answer = (s) => ({ type: "detail", sessionId: "a", detail: { turns: s.transcript.turns, ...K.seriesFor(s.transcript) } });
    const p = panel();
    p.send(list([one]));
    p.row("a").click();
    p.send(answer(one));
    const parts = ["detail-title", "detail-meta", "detail-curve", "detail-output", "detail-turn", "detail-facts", "copy-pid"].map((id) => p.$(id));
    const folder = p.$("detail-meta").firstChild;
    const seen = new p.window.MutationObserver(() => {});
    seen.observe(p.$("detail"), { subtree: true, childList: true, attributes: true, characterData: true });
    p.send(list([two]));
    expect(seen.takeRecords()).toEqual([]); // the answer draws it, not the list
    expect(p.posted.at(-1)).toEqual({ type: "detail", sessionId: "a" });
    p.send(answer(two));
    expect(["detail-title", "detail-meta", "detail-curve", "detail-output", "detail-turn", "detail-facts", "copy-pid"].map((id) => p.$(id))).toEqual(parts);
    expect(p.$("detail-meta").firstChild).toBe(folder);
    expect(folder.title).toBe(MINE);
    expect(p.$("detail-tokens").textContent).toBe("120K");
    expect(p.$("detail-curve").querySelector("svg").getAttribute("data-points")).toBe("6");
    expect(p.$("detail-turn").max).toBe("6");
  });

  it("the pointer and the range read the curve of the last draw, and the shown turn survives a draw", () => {
    const one = session("a", { series: [20000, 50000, 45000] }), two = session("a", { series: [20000, 50000, 45000, 80000] });
    const p = panel();
    p.send(list([one]));
    p.row("a").click();
    const field = p.$("detail-curve");
    field.getBoundingClientRect = () => ({ left: 0, width: 100 });
    field.dispatchEvent(new p.window.MouseEvent("mousemove", { clientX: 50, bubbles: true }));
    expect(p.$("detail-tip").textContent).toMatch(/^turn 2 · 50K · \+30K from turn 1/);
    expect(field.classList.contains("kx-d-hover")).toBe(true);
    p.send(list([two])); // no answer yet for this session: the list draws it
    expect(p.$("detail-curve")).toBe(field);
    expect(field.classList.contains("kx-d-hover")).toBe(true);
    expect(p.$("detail-tip").textContent).toMatch(/^turn 2 · 50K/);
    expect(p.$("detail-turn-value").textContent).toBe("2 / 4");
    const range = p.$("detail-turn");
    range.value = "4";
    range.dispatchEvent(new p.window.Event("input"));
    expect(p.$("detail-tip").textContent).toMatch(/^turn 4 · 80K · \+35K from turn 3/);
    field.dispatchEvent(new p.window.MouseEvent("mouseleave"));
    expect(field.classList.contains("kx-d-hover")).toBe(false);
  });

  it("a copy button gives its receipt, and keeps it through a draw", async () => {
    const p = panel();
    p.send(list([session("a")]));
    p.row("a").click();
    const button = p.$("copy-session");
    expect(button.textContent).toBe("copy");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const receipt = button.textContent;
    expect(["copied", "copy failed"]).toContain(receipt);
    p.send(list([session("a", { tokens: 60000 })]));
    expect(p.$("copy-session")).toBe(button);
    expect(button.textContent).toBe(receipt);
    expect(button.getAttribute("aria-label")).toBe(`${receipt}: a`);
  });

  it("the range shows a turn, with its growth from the turn before", () => {
    const p = panel();
    p.send(list([session("a", { series: [20000, 50000, 45000] })]));
    p.row("a").click();
    const range = p.$("detail-turn");
    range.value = "2";
    range.dispatchEvent(new p.window.Event("input"));
    expect(p.$("detail-tip").textContent).toMatch(/^turn 2 · 50K · \+30K from turn 1/);
    expect(p.$("detail-turn-value").textContent).toBe("2 / 3");
  });

  it("the row's curve and the detail's have the same limit, compaction and dip lines", () => {
    // a compaction at index 3, and a drop at index 6 without one
    const a = session("a", { series: [20000, 60000, 90000, 30000, 50000, 80000, 40000, 60000], compactions: [{ at: 3, trigger: "manual", preTokens: 90000, postTokens: 30000 }] });
    const p = panel();
    p.send(list([a]));
    const lines = (svg) => ["kx-limit", "kx-compact", "kx-dip"].map((c) => [...svg.querySelectorAll(`.${c}`)].map((l) => [l.dataset.limit, l.dataset.trigger, l.getAttribute("x1")]));
    const row = lines(p.row("a").querySelector('[data-testid="curve"]'));
    expect(row.map((l) => l.length)).toEqual([2, 1, 1]);
    expect(row[1][0][1]).toBe("manual");
    p.row("a").click();
    p.send(detailOf(a));
    expect(lines(p.$("detail-curve").querySelector("svg"))).toEqual(row); // both viewBoxes are 100 wide
    expect([...p.$("detail-curve").querySelectorAll(".kx-compact, .kx-dip")].map((l) => l.dataset.turn)).toEqual(["7", "4"]); // turn numbers, from 1
  });
});

describe("panel: what the core decides for it", () => {
  /** The rows of the detail view's facts tables, as [key, value] texts. */
  const facts = (p) => Object.fromEntries([...p.$("detail-facts").querySelectorAll("tr")].map((tr) => [tr.querySelector("th").textContent, tr.querySelector("td").textContent]));

  it("the cache is warm, soon or cold as the core says, in the row and the detail view", () => {
    const p = panel();
    p.send(list([
      session("w", { ago: MIN }), // 1h, 59 min left
      session("s", { ago: 56 * MIN }), // 1h, 4 min left: within SOON_MS
      session("f", { ago: MIN, cacheTtlMs: 5 * MIN }), // 5m, 4 min left: past half its TTL only from 2.5 min
      session("t", { ago: 3 * MIN, cacheTtlMs: 5 * MIN }), // 5m, 2 min left
      session("c", { ago: 10 * MIN, cacheTtlMs: 5 * MIN }),
      session("n", { cacheTtlMs: null }),
    ]));
    const cache = (id) => p.row(id).querySelector('[data-testid="cache"]');
    expect(["w", "s", "f", "t", "c"].map((id) => [cache(id).dataset.cache, cache(id).textContent])).toEqual([
      ["warm", "warm · 59 min1h"], ["soon", "warm · 4 min1h"], ["warm", "warm · 4 min5m"], ["soon", "warm · 2 min5m"], ["cold", "cold5m"],
    ]);
    expect(cache("n")).toBeNull();
    expect(cache("s").title).toMatch(/^Prompt cache: 1-hour TTL, cold at .+ unless a turn is sent \(in 4 min\) · last turn: 45K read from cache \(90 % of the context\), 1K written · /);
    expect(cache("c").title).toMatch(/^Prompt cache: 5-minute TTL, cold since /);
    p.row("s").click();
    expect(facts(p)["Cache now"]).toMatch(/^warm · 4 min left \(cold at .+\)$/);
    p.$("detail-back").click();
    p.row("c").click();
    expect(facts(p)["Cache now"]).toMatch(/^cold since /);
    p.$("detail-back").click();
    p.row("n").click();
    expect(facts(p)["Cache now"]).toBe("unknown");
  });

  it("the output's tooltip and facts have the last turn and the thinking share", () => {
    const p = panel();
    p.send(list([
      session("a"), // 3 turns of 400 out, 100 of them thinking
      session("z", { ago: 2 * MIN, outputSeries: [0, 0, 0], thinkingSeries: [0, 0, 0], outputTotal: 0, thinkingTotal: 0 }),
      session("u", { ago: 3 * MIN, outputSeries: [300, 500], thinkingSeries: [], thinkingTotal: null, outputTotal: 800 }),
    ]));
    const output = (id) => p.row(id).querySelector('[data-testid="output-total"]');
    expect(output("a").textContent).toBe("1K out");
    expect(output("a").title).toBe("Output: last turn 400 out, 100 thinking · session 1K out, 25 % thinking · what the model writes is read back as input on the next turn");
    expect(output("z").title).toBe("Output: last turn 0 out, 0 thinking · session 0 out · what the model writes is read back as input on the next turn");
    expect(output("u").title).toBe("Output: last turn 500 out, 0 thinking · session 800 out · what the model writes is read back as input on the next turn");
    const rows = (id) => { p.row(id).click(); const f = facts(p); p.$("detail-back").click(); return [f["Output, whole session"], f["Of it thinking"], f["Output, last turn"]]; };
    expect(rows("a")).toEqual(["1K", "300 (25 %)", "400 (100 thinking)"]);
    expect(rows("z")).toEqual(["0", "unknown", "0 (0 thinking)"]);
    expect(rows("u")).toEqual(["800", "unknown", "500 (0 thinking)"]);
  });

  it("before the first turn there is no output and no last turn", () => {
    const p = panel();
    p.send(list([session("e", { turns: 0, tokens: null, title: null, outputSeries: [], thinkingSeries: [], outputTotal: 0, thinkingTotal: 0 })]));
    expect(p.row("e").querySelector('[data-testid="output-total"]')).toBeNull();
    p.row("e").click();
    expect(facts(p)["Output, last turn"]).toBe("unknown");
    expect(facts(p)["Of it thinking"]).toBe("unknown");
  });

  it("a session without a title is a new or an untitled session, with the registry's name, in the row and the detail view", () => {
    const p = panel();
    p.send(list([
      session("t", { name: "my-project-08" }),
      session("n", { ago: 2 * MIN, turns: 0, tokens: null, title: null, name: "my-project-08", outputSeries: [], thinkingSeries: [] }),
      session("u", { ago: 3 * MIN, title: null }),
    ]));
    const title = (id) => p.row(id).querySelector(".kx-title");
    expect(["t", "n", "u"].map((id) => [title(id).textContent, title(id).hasAttribute("data-fallback")])).toEqual([
      ["Session t", false], ["new session · my-project-08", true], ["untitled session", true],
    ]);
    expect(p.row("u").getAttribute("aria-label")).toBe("Open details: untitled session, 50K tokens, zone green");
    p.row("n").click();
    expect(p.$("detail-title").textContent).toBe("new session · my-project-08");
    expect(p.$("detail-title").hasAttribute("data-fallback")).toBe(true);
  });

  it("a compaction at the first turn the list keeps shows on the row's curve and in the detail view", () => {
    const compaction = { at: 0, trigger: "auto", preTokens: 900000, postTokens: 40000, durationMs: 60000 };
    const a = session("a", { series: [40000, 60000, 80000], compactions: [compaction] });
    const p = panel();
    p.send(list([a]));
    const marks = [...p.row("a").querySelectorAll('[data-testid="curve"] .kx-compact')];
    expect(marks.map((m) => [m.dataset.turn, m.dataset.trigger])).toEqual([["0", "auto"]]);
    expect(p.row("a").querySelector('[data-testid="curve"]').getAttribute("aria-label")).toBe("Tokens per turn, 3 turns, 1 compaction, 0 other drops");
    expect(p.row("a").querySelector('[data-testid="curve"] title').textContent).toMatch(/ · turn 1: auto-compacted 900K → 40K \(1 min\)/);
    p.row("a").click();
    p.send(detailOf(a));
    expect([...p.$("detail-curve").querySelectorAll(".kx-compact")].map((m) => m.dataset.turn)).toEqual(["1"]); // the detail view numbers turns from 1
  });

  it("past the list's 200 turns the row's curve and the detail view name a compaction by the session's turn number", () => {
    const compaction = { at: 229, trigger: "auto", preTokens: 900000, postTokens: 40000, durationMs: 60000 };
    const a = session("a", { tokens: 90000, turns: 250, compactions: [compaction] }); // turn 230 is index 229 of every turn
    const p = panel();
    p.send(list([a]));
    expect(p.row("a").querySelector('[data-testid="curve"] title').textContent).toMatch(/ · turn 230: auto-compacted 900K → 40K/);
    p.row("a").click();
    const mark = () => p.$("detail-curve").querySelector('[data-testid="detail-compaction"]').title;
    expect(mark()).toBe("turn 230: auto-compacted 900K → 40K (1 min)"); // the list's 200 turns, from turn 51
    p.send(detailOf(a));
    expect(p.$("detail-curve-label").textContent).toMatch(/^Tokens per turn · 250 turns · /);
    expect(mark()).toBe("turn 230: auto-compacted 900K → 40K (1 min)"); // every turn, from turn 1
  });
});

describe("panel: what the host may send", () => {
  it("a payload with missing or wrongly typed fields renders without throwing", () => {
    const p = panel();
    p.send({ type: "sessions" });
    expect(p.$("count").textContent).toBe("0");
    p.send({ type: "sessions", count: 3, sessions: "none", groups: null, errors: [1, "kept"], zoneCounts: null, cacheCounts: "x" });
    expect([...p.$("errors").querySelectorAll(".kx-error")].map((e) => e.textContent)).toEqual(["kept"]);
    p.send({ type: "sessions", count: 2, sessions: [{}, { sessionId: "x", series: "no", compactions: [null], dips: "no", growth: {}, tokens: "12", facts: [1] }] });
    expect(p.rows()).toEqual(["", "x"]);
    p.row("x").click();
    expect(p.$("detail-title").textContent).toBe(""); // the core composes the title (titleText), and this payload has none
    p.send({ type: "detail", sessionId: "x", detail: "no" });
    p.send({ type: "detail", sessionId: "x", detail: { turns: 5, series: [1, 2, 3], firstTurn: "3", compactions: [{ at: 1, trigger: "auto" }] } });
    expect(p.$("detail-curve").querySelector('[data-testid="detail-compaction"]').title).toMatch(/^turn 2: /); // a firstTurn that is not a number counts from 1, never "31"
    p.send({ type: "detail" });
    p.send({ type: "sessions", count: 1, all: true, groups: [null, { project: "p", sessions: null }, { sessions: [{ sessionId: "y" }] }] });
    p.send(null);
    p.send({ type: "unknown" });
  });
});

describe("panel: the demo sessions", () => {
  // The DOM the demo's invented sessions draw, recorded in __snapshots__: a change to how the panel's source is laid
  // out (one file or three, #84) must leave it as it is. The clock is fixed, since the reader measures every age
  // against it.
  it("draw the recorded list, all-projects list and detail", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const data = require("../scripts/demo.cjs").demoData();
      const p = panel({ utc: true });
      p.send({ type: "sessions", ...data.workspace, full: false });
      expect(p.$("list").outerHTML).toMatchSnapshot("workspace list");
      const id = data.workspace.sessions[0].sessionId;
      p.row(id).click();
      p.send({ type: "detail", sessionId: id, detail: data.details[id] });
      expect(p.$("detail").outerHTML).toMatchSnapshot("detail");
      p.$("detail-back").click();
      p.$("scope-all").click();
      p.send({ type: "sessions", ...data.all, full: false });
      expect(p.$("list").outerHTML).toMatchSnapshot("all-projects list");
      expect(p.doc.querySelector("header").outerHTML).toMatchSnapshot("header");
    } finally { vi.useRealTimers(); }
  });
});
