// test/core.test.js — the core behind the "Claude Context" panel (core.cjs): the registry of live Claude
// sessions, the parsing of transcript tails, the zones and the list the panel shows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const K = require("../core.cjs");

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const lines = (name) => readFileSync(`${FIX}transcripts/${name}.jsonl`, "utf8").split("\n");

describe("parseTranscript", () => {
  it("tokens is the sum of input, cache creation and cache read on the last assistant entry, with model and timestamp", () => {
    const t = K.parseTranscript(lines("with-title"));
    expect(t.tokens).toBe(143002);
    expect(t.model).toBe("claude-opus-5-5");
    expect(t.lastTurn).toBe("2026-10-21T20:20:05.500Z");
  });

  it("a turn is one API call: two entries with the same message.id count once", () => {
    expect(K.parseTranscript(lines("with-title")).turns).toBe(2);
  });

  it("the title is the ai-title entry when there is one", () => {
    expect(K.parseTranscript(lines("with-title")).title).toBe("The attendance page is slow");
  });

  it("without an ai-title the title is the first user message, collapsed to one line", () => {
    expect(K.parseTranscript(lines("without-title")).title).toBe("can 171 be implemented now in parallel while I work on other things in other sessions?");
  });

  it("a slash command as the first message shows as the command with its arguments; meta entries and tool results are skipped", () => {
    expect(K.parseTranscript(lines("command-first")).title).toBe("/implement 153");
  });

  it("a sidechain entry (subagent) last in the file does not count: the number is the main session's", () => {
    const t = K.parseTranscript(lines("sidechain-last"));
    expect(t.tokens).toBe(100005);
    expect(t.turns).toBe(1);
    expect(t.lastTurn).toBe("2026-10-21T21:00:10.000Z");
  });

  it("a transcript without usage, with unknown entries and a line that is not JSON, gives null (unknown) and zero turns", () => {
    expect(K.parseTranscript(lines("without-usage"))).toEqual({ tokens: null, model: null, lastTurn: null, title: "What time is it?", turns: 0, series: [] });
  });

  it("a synthetic entry (API error, model <synthetic>, all counters zero) and a usage without input counters are not turns: the number is the previous real reply", () => {
    const t = K.parseTranscript(lines("synthetic-last"));
    expect(t).toEqual({ tokens: 140005, model: "claude-opus-5-5", lastTurn: "2026-10-21T21:00:10.000Z", title: "Continue", turns: 1, series: [140005] });
  });

  it("an empty tail gives unknown for everything", () => {
    expect(K.parseTranscript([])).toEqual({ tokens: null, model: null, lastTurn: null, title: null, turns: 0, series: [] });
  });

  it("the tail parsed as a continuation of the previous state gives the same as the whole file at once", () => {
    const all = lines("with-title");
    const whole = K.parseTranscript(all);
    const first = K.parseTranscript(all.slice(0, 5));
    expect(first).toMatchObject({ turns: 1, tokens: 40004, title: "The attendance page is slow" });
    // the tail alone lacks the title and the first turn …
    expect(K.parseTranscript(all.slice(5))).toMatchObject({ turns: 1, title: "yes" });
    // … but with the previous state the answer equals the whole file
    expect(K.parseTranscript(all.slice(5), first)).toEqual(whole);
    expect(whole.turns).toBe(2);
  });

  // the series is the count per turn, in order, with the same rule as tokens
  it("the series has one number per turn: two entries with the same message.id give one point, and sidechain and synthetic entries do not count", () => {
    expect(K.parseTranscript(lines("with-title")).series).toEqual([40004, 143002]);
    expect(K.parseTranscript(lines("sidechain-last")).series).toEqual([100005]);
    expect(K.parseTranscript(lines("synthetic-last")).series).toEqual([140005]);
  });

  it("the series keeps the last 200 turns: older points fall out first", () => {
    const all = [];
    for (let i = 1; i <= 230; i++) all.push(turn(i, 1000 * i));
    const t = K.parseTranscript(all);
    expect(t.turns).toBe(230);
    expect(t.series.length).toBe(200);
    expect(t.series[0]).toBe(31000);
    expect(t.series[199]).toBe(230000);
    expect(t.tokens).toBe(230000);
  });

  it("the continuation gives the same series as the whole file, also past the 200 limit, and the previous state is not mutated", () => {
    const all = [];
    for (let i = 1; i <= 210; i++) all.push(turn(i, 1000 * i));
    const whole = K.parseTranscript(all);
    const first = K.parseTranscript(all.slice(0, 150));
    const copy = first.series.slice();
    expect(K.parseTranscript(all.slice(150), first)).toEqual(whole);
    expect(first.series).toEqual(copy);
  });

  it("a previous state without a series (older core) gives the point without counting the turn again, and an entry without an id counts as before", () => {
    const all = lines("with-title");
    const first = { tokens: 40004, model: "claude-opus-5-5", lastTurn: "x", title: "T", turns: 1 };
    Object.defineProperty(first, "lastId", { value: "msg_1", enumerable: false });
    const t = K.parseTranscript(all.slice(3), first);
    expect(t.turns).toBe(2);
    expect(t.series).toEqual([40004, 143002]);
    // without message.id and uuid the id is null, like lastId, so the turn is not counted (as before) but the point is drawn
    const withoutId = K.parseTranscript([turn(1, 5000, { uuid: undefined }).replace('"id":"msg_1",', "")]);
    expect(withoutId.turns).toBe(0);
    expect(withoutId.series).toEqual([5000]);
  });

  it("a new entry with the same message.id as the last turn of the previous state updates the point instead of adding one", () => {
    const all = lines("with-title");
    // a1 and a2 are the same turn (msg_1); cut between them
    const first = K.parseTranscript(all.slice(0, 3));
    expect(first.series).toEqual([40004]);
    expect(K.parseTranscript(all.slice(3), first).series).toEqual([40004, 143002]);
  });
});

/** One assistant entry that is a turn of its own (own message.id) with the given context sum. */
function turn(i, tokens, extra = {}) {
  return JSON.stringify({ parentUuid: `u${i}`, isSidechain: false, type: "assistant", uuid: `a${i}`, timestamp: `2026-10-22T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
    message: { id: `msg_${i}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "." }],
      usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } }, ...extra });
}

describe("dips", () => {
  it("a point is a dip when the count is below 70 % of the previous point; the first point is never a dip", () => {
    // 104 999 < 105 000 (70 % of 150 000); 40 000 < 73 500; 28 000 is exactly 70 % of 40 000 and not a dip; 19 599 < 19 600
    expect(K.dips([150000, 104999, 105000, 40000, 28000, 19599])).toEqual([1, 3, 5]);
    expect(K.dips([])).toEqual([]);
    expect(K.dips([5000])).toEqual([]);
    expect(K.dips([100000, 70000])).toEqual([]);
    expect(K.dips([100000, 69999])).toEqual([1]);
  });
});

describe("zone", () => {
  it("green below 100 000, yellow up to and including 150 000, red above, null without a number", () => {
    expect(K.zone(99999)).toBe("green");
    expect(K.zone(100000)).toBe("yellow");
    expect(K.zone(150000)).toBe("yellow");
    expect(K.zone(150001)).toBe("red");
    expect(K.zone(null)).toBeNull();
  });
});

describe("projectSlug", () => {
  it("replaces slashes and every other non-alphanumeric character with a dash, like Claude Code", () => {
    expect(K.projectSlug("/Users/frode/Dev/my-project")).toBe("-Users-frode-Dev-my-project");
    expect(K.projectSlug("/Users/frode/.claude/skills")).toBe("-Users-frode--claude-skills");
  });
});

describe("readRegistry", () => {
  it("returns the entries of live processes and skips dead ones, invalid JSON and other files", () => {
    const r = K.readRegistry(`${FIX}registry`, (pid) => pid === 1303 || pid === 5555);
    expect(r.error).toBeNull();
    expect(r.sessions.map((s) => s.pid)).toEqual([1303, 5555]);
    expect(r.sessions[0]).toMatchObject({ sessionId: "aaaa-1", cwd: "/Users/frode/Dev/my-project", status: "busy" });
  });

  it("a missing registry folder gives an error text and an empty list, not an exception", () => {
    const r = K.readRegistry(`${FIX}does-not-exist`, () => true);
    expect(r.sessions).toEqual([]);
    expect(r.error).toBe(`Registry folder not found: ${FIX}does-not-exist`);
  });
});

describe("readTail", () => {
  const file = `${FIX}transcripts/with-title.jsonl`;
  const whole = readFileSync(file, "utf8");

  it("the last bytes give whole lines: a truncated first line is dropped", () => {
    // 700 bytes from the end cut inside the a2 line, so only ai-title, u2 and a3 are whole
    const h = K.readTail(file, { bytes: 700 });
    expect(h.lines.length).toBe(3);
    expect(h.lines[0].startsWith('{"type":"ai-title"')).toBe(true);
    expect(h.end).toBe(Buffer.byteLength(whole));
  });

  it("from an offset the rest of the file is read, and a missing file gives no lines", () => {
    const first = whole.indexOf("\n") + 1;
    const h = K.readTail(file, { from: Buffer.byteLength(whole.slice(0, first)) });
    expect(h.lines.length).toBe(6);
    expect(h.lines[0].startsWith('{"parentUuid":null')).toBe(true);
    expect(K.readTail(`${FIX}transcripts/does-not-exist.jsonl`, { bytes: 100 })).toEqual({ lines: [], end: 0, missing: true, restarted: false });
  });

  it("an offset past the end (the file was rewritten shorter) reads from the start and says so, so the previous state is dropped", () => {
    const h = K.readTail(file, { from: Buffer.byteLength(whole) + 1000 });
    expect(h.lines.length).toBe(7);
    expect(h.restarted).toBe(true);
    expect(K.readTail(file, { from: 0 }).restarted).toBe(false);
  });
});

describe("buildSessions", () => {
  const NOW = "2026-10-21T22:40:00.000Z";
  const MINE = "/Users/frode/Dev/my-project", OTHER = "/Users/frode/Dev/other-project";
  const reg = (pid, sessionId, cwd, status) => ({ pid, sessionId, cwd, status });
  const tail = (tokens, lastTurn, extra = {}) => ({ tokens, model: "claude-opus-5-5", lastTurn, title: "T", turns: 3, ...extra });
  const registry = [
    reg(1, "old", MINE, "idle"),
    reg(2, "new", MINE, "idle"),
    reg(3, "busy", MINE, "busy"),
    reg(4, "other", OTHER, "idle"),
    reg(5, "without", MINE, "idle"),
  ];
  const transcripts = {
    old: tail(170500, "2026-10-21T21:20:00.000Z"),           // 1 h 20 min ago → dimmed, red
    new: tail(143002, "2026-10-21T22:28:00.000Z", { model: "claude-fable-5-1" }), // 12 min ago, yellow
    busy: tail(20000, "2026-10-21T20:00:00.000Z"),           // busy, although the last turn is old
    other: tail(5000, "2026-10-21T22:39:30.000Z"),
    // "without" has no transcript yet
  };

  it("the default scope is the window's workspace folders: busy first, then last turn newest first, unknown last", () => {
    const r = K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: false });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["busy", "new", "old", "without"]);
    expect(r.groups).toBeNull();
    expect(r.count).toBe(4);
  });

  it("per session: zone, short model name, time since the last turn, dimming after one hour and busy", () => {
    const r = K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: false });
    const [busy, fresh, old, without] = r.sessions;
    expect(fresh).toMatchObject({ tokens: 143002, zone: "yellow", modelShort: "Fable 5.1", turns: 3,
      sinceMs: 12 * 60000, busy: false, dimmed: false, project: "my-project", title: "T" });
    expect(old).toMatchObject({ zone: "red", dimmed: true, sinceMs: 80 * 60000, modelShort: "Opus 5.5" });
    expect(busy).toMatchObject({ busy: true, zone: "green", dimmed: true });
    expect(without).toMatchObject({ tokens: null, zone: null, modelShort: null, title: null, turns: 0, sinceMs: null, dimmed: false });
  });

  it("all projects takes the whole machine grouped per project, in the order of the list", () => {
    const r = K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: true });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["busy", "other", "new", "old", "without"]);
    expect(r.groups.map((g) => [g.project, g.sessions.map((s) => s.sessionId)])).toEqual([
      ["my-project", ["busy", "new", "old", "without"]],
      ["other-project", ["other"]],
    ]);
  });

  it("every session gets the series and the dip indexes from its transcript, an empty list without a transcript", () => {
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: tail(143002, NOW, { series: [40004, 143002, 60000, 143002] }) },
      now: NOW, workspaceFolders: [MINE], all: false });
    const fresh = r.sessions.find((s) => s.sessionId === "new");
    expect(fresh.series).toEqual([40004, 143002, 60000, 143002]);
    expect(fresh.dips).toEqual([2]);
    const without = r.sessions.find((s) => s.sessionId === "without");
    expect(without.series).toEqual([]);
    expect(without.dips).toEqual([]);
  });

  it("the count per zone covers the listed sessions, unknown is not counted, and with all projects everything shown is counted", () => {
    expect(K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: false }).zoneCounts).toEqual({ green: 1, yellow: 1, red: 1 });
    expect(K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: true }).zoneCounts).toEqual({ green: 2, yellow: 1, red: 1 });
    expect(K.buildSessions({ registry: [], transcripts: {}, now: NOW, workspaceFolders: [MINE], all: false }).zoneCounts).toEqual({ green: 0, yellow: 0, red: 0 });
  });

  it("a session in a subfolder of the workspace folder belongs to the window, one in a folder with the same prefix does not", () => {
    const r = K.buildSessions({
      registry: [reg(1, "below", `${MINE}/packages/app`, "idle"), reg(2, "prefix", `${MINE}2`, "idle")],
      transcripts: {}, now: NOW, workspaceFolders: [MINE], all: false,
    });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["below"]);
  });

  it("without workspace folders (no folder open) everything is shown", () => {
    const r = K.buildSessions({ registry: [reg(1, "a", MINE, "idle"), reg(2, "b", OTHER, "idle")],
      transcripts: { a: tail(950, NOW), b: tail(1234567, NOW) }, now: NOW, workspaceFolders: [], all: false });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(r.sessions[0].sinceMs).toBe(0);
  });
});

describe("SessionReader", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const MINE = "/Users/frode/Dev/my-project";
  const all = lines("with-title").filter(Boolean);

  function rig({ withProjectFolder = true } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-context-"));
    mkdirSync(path.join(dir, "sessions"));
    writeFileSync(path.join(dir, "sessions", "1303.json"), JSON.stringify({ pid: 1303, sessionId: "aaaa-1", cwd: MINE, status: "busy" }));
    writeFileSync(path.join(dir, "sessions", "9.json"), JSON.stringify({ pid: 9, sessionId: "dead", cwd: MINE, status: "idle" }));
    const folder = path.join(dir, "projects", K.projectSlug(MINE));
    if (withProjectFolder) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "aaaa-1.jsonl"), all.slice(0, 5).join("\n") + "\n");
    }
    return { dir, folder, file: path.join(folder, "aaaa-1.jsonl") };
  }

  it("reads the registry (live processes only) and the transcript, and takes only the new bytes next time", () => {
    const { dir, file, folder } = rig();
    try {
      const reader = new K.SessionReader(dir, { alive: (pid) => pid === 1303 });
      const first = reader.read({ workspaceFolders: [MINE], all: false });
      expect(first.errors).toEqual([]);
      expect(first.count).toBe(1);
      expect(first.sessions[0]).toMatchObject({ sessionId: "aaaa-1", busy: true, turns: 1, tokens: 40004, title: "The attendance page is slow" });
      expect(first.projectFolders).toEqual([folder]);
      expect(reader.cache.get(file).end).toBe(Buffer.byteLength(all.slice(0, 5).join("\n") + "\n"));

      appendFileSync(file, all.slice(5).join("\n") + "\n");
      const second = reader.read({ workspaceFolders: [MINE], all: false });
      expect(second.sessions[0]).toMatchObject({ turns: 2, tokens: 143002, model: "claude-opus-5-5" });
      expect(typeof second.generatedAt).toBe("string");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a missing project folder is listed in errors, and the session is shown as unknown", () => {
    const { dir, folder } = rig({ withProjectFolder: false });
    try {
      const result = new K.SessionReader(dir, { alive: () => true }).read({ workspaceFolders: [MINE], all: false });
      expect(result.errors).toEqual([`Project folder not found: ${folder}`]);
      expect(result.sessions.map((s) => [s.sessionId, s.tokens])).toEqual([["aaaa-1", null], ["dead", null]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a missing registry folder gives the error text and an empty list", () => {
    const result = new K.SessionReader(`${FIX}does-not-exist`).read({ workspaceFolders: [MINE], all: false });
    expect(result.errors).toEqual([`Registry folder not found: ${path.join(`${FIX}does-not-exist`, "sessions")}`]);
    expect(result.count).toBe(0);
  });
});

describe("SessionWatcher", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  it("a change in sessions/ gives one call after the debounce, a missing folder is skipped, and stop() closes everything", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-context-watch-"));
    mkdirSync(path.join(dir, "sessions"));
    let calls = 0;
    const watcher = new K.SessionWatcher(dir, () => { calls += 1; }, { debounceMs: 30, tickMs: 60000 });
    try {
      watcher.start();
      expect([...watcher.watchers.keys()]).toEqual([path.join(dir, "sessions")]); // projects/ does not exist yet
      writeFileSync(path.join(dir, "sessions", "1.json"), "{}");
      writeFileSync(path.join(dir, "sessions", "2.json"), "{}");
      for (let i = 0; i < 40 && calls === 0; i++) await wait(50);
      expect(calls).toBe(1);
      mkdirSync(path.join(dir, "projects", "p"), { recursive: true });
      watcher.watchAll([path.join(dir, "projects", "p"), path.join(dir, "does-not-exist")]);
      expect(watcher.watchers.size).toBe(2);
      watcher.stop();
      expect(watcher.watchers.size).toBe(0);
      expect(watcher.tick).toBeNull();
    } finally { watcher.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});
