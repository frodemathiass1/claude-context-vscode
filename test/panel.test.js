// test/panel.test.js — the webview (panel.html), run in jsdom as a host loads it: a stand-in for acquireVsCodeApi
// records what the panel posts and keeps its state, and the host's messages come as `message` events with lists
// from the real buildSessions, so the panel is fed what the hosts send it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const K = require("../core.cjs");
const { JSDOM, VirtualConsole } = require("jsdom");

const PANEL = readFileSync(fileURLToPath(new URL("../panel.html", import.meta.url)), "utf8");
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
 * panel.html loaded as extension.js loads it (the CSP, the nonce), with `state` as the webview state it starts
 * with. The page's timers are the test's, so vi.useFakeTimers() moves them.
 */
function panel({ state = null } = {}) {
  const html = PANEL.replace("<!-- csp -->", `<meta http-equiv="Content-Security-Policy" content="${K.pageCsp("n")}">`).replace(/\{\{nonce\}\}/g, "n");
  const posted = [], errors = [];
  let saved = state;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  virtualConsole.on("error", (...a) => errors.push(a.join(" ")));
  const { window } = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.acquireVsCodeApi = () => ({ getState: () => saved, setState: (s) => { saved = s; }, postMessage: (m) => posted.push(m) });
      for (const name of ["setTimeout", "clearTimeout"]) w[name] = (...a) => globalThis[name](...a);
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
  };
  opened.push(p);
  return p;
}

/** One live session: its registry entry and its parsed transcript, as SessionReader hands them to buildSessions. */
function session(sessionId, { tokens = 50000, status = "idle", model = "claude-opus-5-5", title = `Session ${sessionId}`, turns = 3,
  ago = MIN, startedAgo = 10 * MIN, cwd = MINE, series } = {}) {
  const all = series || Array.from({ length: turns }, (_, i) => Math.round((tokens * (i + 1)) / turns));
  return {
    registry: { pid: 1000 + sessionId.charCodeAt(0), sessionId, cwd, status, startedAt: NOW - startedAgo, name: null },
    transcript: {
      tokens, model, title, turns, series: all, lastTurn: new Date(NOW - ago).toISOString(),
      outputSeries: all.map(() => 400), thinkingSeries: all.map(() => 100), outputTotal: 400 * all.length, thinkingTotal: 100 * all.length,
      cacheTtlMs: HOUR, cacheRead: Math.round(tokens * 0.9), cacheCreated: 1000, compactions: [],
      baseline: all[0], baselineAt: 0, baselineCause: "start", growthBySource: { Bash: 5000, you: 1000 },
    },
  };
}

/** The `sessions` message a host posts for these sessions (SessionReader.read's payload). */
function list(sessions, { all = false, full = false, errors = [], workspaceFolders = [] } = {}) {
  const transcripts = Object.fromEntries(sessions.map((s) => [s.registry.sessionId, s.transcript]));
  const built = K.buildSessions({ registry: sessions.map((s) => s.registry), transcripts, now: NOW, workspaceFolders, all });
  return { type: "sessions", ...built, all, full, errors, generatedAt: new Date(NOW).toISOString(), projectFolders: [] };
}

describe("panel: the list", () => {
  it("posts ready at start, and a list renders its count, its zone counts and its rows in the core's order", () => {
    const p = panel();
    expect(p.posted).toEqual([{ type: "ready" }]);
    p.send(list([
      session("d", { tokens: 110000, ago: MIN }), session("c", { tokens: 160000, ago: 2 * MIN }),
      session("b", { tokens: 130000, status: "waiting" }), session("a", { tokens: 50000, status: "busy" }),
    ]));
    expect(p.$("count").textContent).toBe("4");
    expect(["green", "yellow", "orange", "red"].map((z) => p.$(`zone-${z}`).textContent)).toEqual(["1", "1", "1", "1"]);
    expect(p.rows()).toEqual(["a", "b", "d", "c"]); // busy, waiting, then the last turn newest first
    expect(p.$$("fold").map((b) => b.dataset.group)).toEqual(["busy", "waiting", "idle"]);
    expect(p.row("c").dataset.zone).toBe("red");
  });

  it("the panel's tokensText agrees with the core's, around 1 000 and 1 000 000 too", () => {
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
    p.send(list([session("g", { tokens: 20000 }), session("o", { tokens: 130000 }), session("r", { tokens: 160000 }),
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
    expect(p.doc.activeElement).toBe(p.fold("abandoned")); // the render replaced the button; the focus stays on it
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

describe("panel: the zone scale", () => {
  const marks = (p) => p.$$("zone-mark").map((m) => [m.style.getPropertyValue("--t"), m.dataset.zone]);

  it("draws the zones at their true widths on 0–200K, the limits labelled, and says what applies in each", () => {
    const p = panel();
    p.send(list([session("a")]));
    expect(["green", "yellow", "orange", "red"].map((z) => p.$(`band-${z}`).style.getPropertyValue("--w"))).toEqual(["50", "12.5", "12.5", "25"]);
    expect([...p.doc.querySelectorAll(".kx-zlabels span")].map((s) => s.textContent)).toEqual(["0", "100K", "125K", "150K", "200K"]);
    expect(p.$("band-green").title).toBe("green zone: below 100K");
    expect(p.$("band-yellow").title).toBe("yellow zone: 100K–125K · Plan to break at the next phase boundary.");
    expect(p.$("band-red").title).toMatch(/^red zone: above 150K · Do not start a new phase/);
  });

  it("marks every session with a known count at its count in its zone colour, above the scale at the end", () => {
    const p = panel();
    p.send(list([session("a", { tokens: 39000 }), session("b", { tokens: 160000, title: "Big one" }), session("c", { tokens: null, turns: 0 })]));
    expect(marks(p)).toEqual([["19.5", "green"], ["80", "red"]]);
    expect(p.$$("zone-mark")[1].title).toBe("Big one · 160K tokens, zone red");
    expect(p.doc.querySelector(".kx-ztrack .kx-over")).toBeNull();
    p.send(list([session("a", { tokens: 250000 })]));
    expect(marks(p)).toEqual([["100", "red"]]);
    expect(p.$$("zone-mark")[0].title).toMatch(/over the 200K scale$/);
    expect(p.doc.querySelector(".kx-ztrack .kx-over")).not.toBeNull();
  });

  it("follows the scope, and not the view's filters, as the counts do", () => {
    const p = panel();
    const mine = session("a", { tokens: 39000 }), other = session("b", { tokens: 130000, cwd: OTHER });
    p.send(list([mine, other], { workspaceFolders: [MINE] }));
    expect(marks(p)).toEqual([["19.5", "green"]]);
    p.send(list([mine, other], { workspaceFolders: [MINE], all: true }));
    expect(marks(p).sort()).toEqual([["19.5", "green"], ["65", "orange"]]);
    expect(p.$("zone-orange").textContent).toBe("1");
    p.$("filter-hot").click(); // hides the green row, not its mark
    expect(marks(p)).toHaveLength(2);
  });

  it("is one image to assistive technology, its label naming the limits and the counts", () => {
    const p = panel();
    p.send(list([session("a", { tokens: 39000 }), session("b", { tokens: 160000 })]));
    expect(p.$("zone-scale").getAttribute("role")).toBe("img");
    expect(p.$("zone-scale").getAttribute("aria-label")).toBe(
      "Zones on a 0–200K scale: green below 100K, yellow 100K–125K, orange 125K–150K and red above 150K. 1 green, 0 yellow, 0 orange, 1 red");
    p.send(list([]));
    expect(p.$("zone-scale").getAttribute("aria-label")).toMatch(/\. No sessions with a known zone$/);
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
    expect(p.$("detail-title").textContent).toBe("new session");
    p.send({ type: "detail", sessionId: "x", detail: "no" });
    p.send({ type: "detail" });
    p.send({ type: "sessions", count: 1, all: true, groups: [null, { project: "p", sessions: null }, { sessions: [{ sessionId: "y" }] }] });
    p.send(null);
    p.send({ type: "unknown" });
  });
});
