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

  it("a session where only a local command ran is titled by the command: no turns, no count, and its output is never the title", () => {
    const t = K.parseTranscript(lines("local-command-only"));
    expect(t).toMatchObject({ title: "/context all", turns: 0, tokens: null, series: [] });
    const stdoutOnly = lines("local-command-only").filter((l) => l.includes("local-command-stdout"));
    expect(K.parseTranscript(stdoutOnly).title).toBeNull();
  });

  it("a user message after a local command is the title, also when it comes in a later read", () => {
    const user = JSON.stringify({ type: "user", message: { role: "user", content: "why is the panel slow" }, uuid: "u9" });
    expect(K.parseTranscript([...lines("local-command-only"), user]).title).toBe("why is the panel slow");
    expect(K.parseTranscript([user], K.parseTranscript(lines("local-command-only"))).title).toBe("why is the panel slow");
  });

  it("a sidechain entry (subagent) last in the file does not count: the number is the main session's", () => {
    const t = K.parseTranscript(lines("sidechain-last"));
    expect(t.tokens).toBe(100005);
    expect(t.turns).toBe(1);
    expect(t.lastTurn).toBe("2026-10-21T21:00:10.000Z");
  });

  it("a transcript without usage, with unknown entries and a line that is not JSON, gives null (unknown) and zero turns", () => {
    expect(K.parseTranscript(lines("without-usage"))).toEqual({ tokens: null, model: null, lastTurn: null, title: "What time is it?", turns: 0, series: [], cacheTtlMs: null, cacheRead: null, cacheCreated: null, compactions: [], outputSeries: [], thinkingSeries: [], outputTotal: 0, thinkingTotal: 0, effort: null, baseline: null, baselineAt: null, baselineCause: null, growthBySource: {} });
  });

  it("a synthetic entry (API error, model <synthetic>, all counters zero) and a usage without input counters are not turns: the number is the previous real reply", () => {
    const t = K.parseTranscript(lines("synthetic-last"));
    expect(t).toEqual({ tokens: 140005, model: "claude-opus-5-5", lastTurn: "2026-10-21T21:00:10.000Z", title: "Continue", turns: 1, series: [140005], cacheTtlMs: 3600000, cacheRead: 100000, cacheCreated: 40000, compactions: [], outputSeries: [30], thinkingSeries: [0], outputTotal: 30, thinkingTotal: 0, effort: null, baseline: 140005, baselineAt: 0, baselineCause: "start", growthBySource: {} });
  });

  it("an empty tail gives unknown for everything", () => {
    expect(K.parseTranscript([])).toEqual({ tokens: null, model: null, lastTurn: null, title: null, turns: 0, series: [], cacheTtlMs: null, cacheRead: null, cacheCreated: null, compactions: [], outputSeries: [], thinkingSeries: [], outputTotal: 0, thinkingTotal: 0, effort: null, baseline: null, baselineAt: null, baselineCause: null, growthBySource: {} });
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

  it("the series keeps every turn of the transcript; the list's cut to the last 200 is seriesFor's", () => {
    const all = [];
    for (let i = 1; i <= 230; i++) all.push(turn(i, 1000 * i));
    const t = K.parseTranscript(all);
    expect(t.turns).toBe(230);
    expect(t.series.length).toBe(230);
    expect(t.series[0]).toBe(1000);
    expect(t.tokens).toBe(230000);
    const listed = K.seriesFor(t, 200).series;
    expect(listed.length).toBe(200);
    expect(listed[0]).toBe(31000);
    expect(listed[199]).toBe(230000);
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

  // the prompt cache: the TTL Claude Code chose, read from the last turn that created cache, and the two counters of the last turn
  it("cacheTtlMs is one hour when the last turn that created cache had ephemeral_1h_input_tokens, and cacheRead and cacheCreated are the last turn's counters", () => {
    const t = K.parseTranscript(lines("with-title"));
    expect(t).toMatchObject({ cacheTtlMs: 3600000, cacheRead: 142000, cacheCreated: 1000 });
  });

  it("the TTL drops to five minutes when a turn creates cache with ephemeral_5m_input_tokens, and a turn that creates nothing keeps the previous TTL", () => {
    const all = lines("ttl-drop");
    expect(K.parseTranscript(all.slice(0, 2))).toMatchObject({ cacheTtlMs: 3600000, cacheRead: 0, cacheCreated: 50000 });
    expect(K.parseTranscript(all.slice(0, 3))).toMatchObject({ cacheTtlMs: 300000, cacheRead: 50000, cacheCreated: 2000 });
    expect(K.parseTranscript(all)).toMatchObject({ cacheTtlMs: 300000, cacheRead: 52000, cacheCreated: 0, tokens: 52004 });
  });

  it("the TTL is null until a turn with cache creation is seen: a flat counter without the nested object says nothing, and so does a usage without cache_creation", () => {
    expect(K.parseTranscript([turn(1, 5000)])).toMatchObject({ cacheTtlMs: null, cacheRead: 0, cacheCreated: 0 });
    const flatOnly = K.parseTranscript([turn(1, 5000, {}, { cache_creation_input_tokens: 4000 })]);
    expect(flatOnly).toMatchObject({ cacheTtlMs: null, cacheCreated: 4000, tokens: 9000 });
    // a nested object with both counters at zero is a turn that created nothing
    expect(K.parseTranscript([turn(1, 5000, {}, { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })]).cacheTtlMs).toBeNull();
  });

  it("a turn that wrote cache under both TTLs reports five minutes: that part goes cold first", () => {
    const t = K.parseTranscript([turn(1, 5000, {}, { cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 } })]);
    expect(t.cacheTtlMs).toBe(300000);
  });

  it("a sidechain turn with a different TTL does not count: the TTL and the counters are the main session's", () => {
    expect(K.parseTranscript(lines("sidechain-last"))).toMatchObject({ cacheTtlMs: 3600000, cacheRead: 40000, cacheCreated: 60000 });
  });

  it("the three cache fields continue over a tail like the others", () => {
    const all = lines("ttl-drop");
    const whole = K.parseTranscript(all);
    const first = K.parseTranscript(all.slice(0, 2));
    expect(K.parseTranscript(all.slice(2), first)).toEqual(whole);
    // a tail without any cache creation keeps the TTL of the previous state
    expect(K.parseTranscript(all.slice(3), K.parseTranscript(all.slice(0, 3)))).toMatchObject({ cacheTtlMs: 300000, cacheRead: 52000 });
    // a previous state without the fields (older core) starts from null
    const older = { tokens: 50005, model: "claude-opus-5-5", lastTurn: "x", title: "T", turns: 1, series: [50005] };
    expect(K.parseTranscript(all.slice(3), older)).toMatchObject({ cacheTtlMs: null, cacheRead: 52000, cacheCreated: 0 });
  });

  // compactions: the compact_boundary entry Claude Code writes, at the first turn after it
  it("a compact_boundary gives a compaction at the index of the first turn after it, with the trigger and the counts before and after", () => {
    const t = K.parseTranscript(lines("compaction"));
    expect(t.series).toEqual([80000, 120000, 160000, 35000, 40000]);
    expect(t.compactions).toEqual([{ at: 3, trigger: "auto", preTokens: 160500, postTokens: 30000, durationMs: 114000 }]);
    expect(K.parseTranscript(lines("with-title")).compactions).toEqual([]);
  });

  it("the compactions continue over a tail, also when the tail ends right after the boundary", () => {
    const all = lines("compaction");
    const whole = K.parseTranscript(all);
    for (const cut of [2, 6, 7, 8]) expect(K.parseTranscript(all.slice(cut), K.parseTranscript(all.slice(0, cut)))).toEqual(whole);
    // a boundary with no turn after it yet is not a compaction in the series
    expect(K.parseTranscript(all.slice(0, 7)).compactions).toEqual([]);
  });

  it("the compaction index stays the turn's index in the whole series; cut to 200 turns it moves with the cut and drops out with its turn", () => {
    const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: false, compactMetadata: { trigger: "manual", preTokens: 9, postTokens: 1 } });
    const all = [];
    for (let i = 1; i <= 205; i++) { if (i === 10) all.push(boundary); all.push(turn(i, 1000 * i)); }
    const c = { trigger: "manual", preTokens: 9, postTokens: 1, durationMs: null };
    // turn 10 is index 9; cut to 200, five turns fall out, so it is index 4
    expect(K.parseTranscript(all).compactions).toEqual([{ at: 9, ...c }]);
    expect(K.seriesFor(K.parseTranscript(all), 200).compactions).toEqual([{ at: 4, ...c }]);
    all.push(...Array.from({ length: 5 }, (_, j) => turn(206 + j, 1000)));
    expect(K.parseTranscript(all).compactions).toEqual([{ at: 9, ...c }]);
    expect(K.seriesFor(K.parseTranscript(all), 200).compactions).toEqual([]);
  });

  it("a boundary without metadata or in a sidechain: the first gives a compaction without numbers, the second nothing", () => {
    const bare = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: false });
    const side = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: true, compactMetadata: { trigger: "auto" } });
    expect(K.parseTranscript([turn(1, 5000), bare, turn(2, 1000)]).compactions).toEqual([{ at: 1, trigger: null, preTokens: null, postTokens: null, durationMs: null }]);
    expect(K.parseTranscript([turn(1, 5000), side, turn(2, 1000)]).compactions).toEqual([]);
  });

  // output: what the model wrote per turn, thinking included, and the effort it ran at
  it("output and thinking per turn are aligned with the series and summed for the transcript; effort is the last turn's", () => {
    const t = K.parseTranscript(lines("compaction"));
    expect(t.outputSeries).toEqual([100, 100, 100, 100, 100]);
    expect(t.thinkingSeries).toEqual([20, 20, 20, 20, 20]);
    expect(t).toMatchObject({ outputTotal: 500, thinkingTotal: 100, effort: "xhigh" });
  });

  it("every block of a response carries the same output counters, so a turn counts them once; a later block with other numbers replaces them", () => {
    const out = (o, th) => ({ output_tokens: o, output_tokens_details: { thinking_tokens: th } });
    const block = (i, o, th, effort) => turn(i, 5000, { effort }, out(o, th));
    const same = [block(1, 700, 100, "medium"), block(1, 700, 100, "medium"), block(1, 700, 100, "medium"), block(2, 50, 0, "xhigh")];
    expect(K.parseTranscript(same)).toMatchObject({ outputSeries: [700, 50], thinkingSeries: [100, 0], outputTotal: 750, thinkingTotal: 100, effort: "xhigh", turns: 2 });
    const growing = [block(1, 300, 10), block(1, 700, 100)];
    expect(K.parseTranscript(growing)).toMatchObject({ outputSeries: [700], outputTotal: 700, thinkingTotal: 100 });
    // cut between two blocks of the same turn: the continuation does not count the turn twice
    expect(K.parseTranscript(same.slice(1), K.parseTranscript(same.slice(0, 1)))).toEqual(K.parseTranscript(same));
  });

  it("a usage without output_tokens_details gives zero thinking, an entry without effort gives no effort, and the output fields continue over a tail", () => {
    expect(K.parseTranscript([turn(1, 5000, {}, { output_tokens: 42 })])).toMatchObject({ outputSeries: [42], thinkingSeries: [0], outputTotal: 42, thinkingTotal: 0, effort: null });
    const all = lines("compaction");
    expect(K.parseTranscript(all.slice(4), K.parseTranscript(all.slice(0, 4)))).toEqual(K.parseTranscript(all));
    // past 200 turns the output series is kept whole like the series, and cut with it for the list
    const many = Array.from({ length: 205 }, (_, j) => turn(j + 1, 1000, {}, { output_tokens: 2 }));
    const t = K.parseTranscript(many);
    expect(t.outputSeries.length).toBe(205);
    expect(t.outputTotal).toBe(410);
    expect(K.seriesFor(t, 200)).toMatchObject({ outputSeries: Array(200).fill(2), thinkingSeries: Array(200).fill(0) });
  });

  // the baseline: the first turn of the current segment, which starts with the transcript or at a compaction
  it("the baseline is the first turn's count, from the start of the transcript", () => {
    expect(K.parseTranscript(lines("with-title"))).toMatchObject({ baseline: 40004, baselineAt: 0, baselineCause: "start" });
  });

  it("a compaction starts a new segment: the baseline is the first turn after it", () => {
    expect(K.parseTranscript(lines("compaction"))).toMatchObject({ baseline: 35000, baselineAt: 3, baselineCause: "compaction" });
    // a boundary with no turn after it yet keeps the segment that is
    expect(K.parseTranscript(lines("compaction").slice(0, 7))).toMatchObject({ baseline: 80000, baselineAt: 0, baselineCause: "start" });
  });

  it("a later block of the first turn updates the baseline, a block of a later turn does not", () => {
    const first = [turn(1, 5000), turn(1, 6000), turn(2, 9000), turn(2, 9500)];
    expect(K.parseTranscript(first)).toMatchObject({ baseline: 6000, baselineAt: 0, series: [6000, 9500] });
    // also when the tail is cut between the two blocks of the first turn
    expect(K.parseTranscript(first.slice(1), K.parseTranscript(first.slice(0, 1)))).toEqual(K.parseTranscript(first));
  });

  it("the baseline continues over a tail, and is null before any turn and for a state from an older core", () => {
    const all = lines("compaction");
    const whole = K.parseTranscript(all);
    for (const cut of [1, 2, 7, 8, 9]) expect(K.parseTranscript(all.slice(cut), K.parseTranscript(all.slice(0, cut)))).toEqual(whole);
    expect(K.parseTranscript(all.slice(0, 1))).toMatchObject({ baseline: null, baselineAt: null, baselineCause: null });
    // an older state has turns but no baseline: the next turn is not the first, so the baseline stays unknown
    const older = { tokens: 80000, model: "claude-opus-5-5", lastTurn: "x", title: "T", turns: 1, series: [80000] };
    expect(K.parseTranscript(all.slice(2, 4), older)).toMatchObject({ baseline: null, baselineCause: null });
  });

  it("baselineAt is the index in the whole series; cut to 200 turns it moves with the cut and is null once the first turn falls out, the baseline stays", () => {
    const all = Array.from({ length: 201 }, (_, j) => turn(j + 1, 1000 * (j + 1)));
    const whole = K.parseTranscript(all);
    expect(whole).toMatchObject({ baseline: 1000, baselineAt: 0, baselineCause: "start" });
    expect(whole.series[whole.baselineAt]).toBe(whole.baseline);
    expect(K.seriesFor(whole, 200).baselineAt).toBeNull();
    const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: false, compactMetadata: { trigger: "auto" } });
    const later = K.parseTranscript([...all.slice(0, 10), boundary, ...all.slice(10)]);
    expect(later).toMatchObject({ baseline: 11000, baselineAt: 10, baselineCause: "compaction" });
    expect(later.series[later.baselineAt]).toBe(later.baseline);
    expect(K.seriesFor(later, 200).baselineAt).toBe(9);
  });

  // the growth by source: each turn's growth split over the previous output and what entered since
  it("one tool per turn: the growth is the previous turn's output first, the rest the tool's result", () => {
    const t = K.parseTranscript([said("go"), call(1, 10000, 200, [["t1", "Read"]]), result([["t1", "x".repeat(4000)]]),
      call(2, 13200, 300, [["t2", "Bash"]]), result([["t2", "y".repeat(100)]]), call(3, 14000, 50)]);
    expect(t.growthBySource).toEqual({ output: 500, Read: 3000, Bash: 500 });
  });

  it("two tools in one turn split the rest in proportion to the length of their results; an image weighs a fixed length", () => {
    const two = [call(1, 10000, 100, [["a", "Read"], ["b", "Grep"]]), result([["a", "x".repeat(3000)]]), result([["b", [{ type: "text", text: "y".repeat(1000) }]]]), call(2, 14100, 10)];
    expect(K.parseTranscript(two).growthBySource).toEqual({ output: 100, Read: 3000, Grep: 1000 });
    // the image's base64 is long, but it counts as IMAGE_CHARS (3 500), as much as the 3 500 characters of text
    const image = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(500000) } }];
    const mixed = [call(1, 10000, 0, [["a", "Read"], ["b", "Grep"]]), result([["a", image], ["b", "y".repeat(3500)]]), call(2, 12000, 0)];
    expect(K.parseTranscript(mixed).growthBySource).toEqual({ Read: 1000, Grep: 1000 });
  });

  it("the user's text is \"you\", rendered attachments and meta entries \"other\"; with nothing seen the rest is \"other\"", () => {
    const t = K.parseTranscript([call(1, 10000, 100), said("x".repeat(600)), attached("z".repeat(300)), said("m".repeat(100), { isMeta: true }),
      JSON.stringify({ type: "attachment", isSidechain: false, attachment: { type: "deferred_tools_record" } }), call(2, 11100, 5), call(3, 11150, 0)]);
    // turn 2: 100 output, 1 000 split 600 / 400; turn 3: 5 output, 45 with nothing seen
    expect(t.growthBySource).toEqual({ output: 105, you: 600, other: 445 });
  });

  it("a fall is not attributed, a compaction starts over, and sidechain results and results without a known call do not take a tool's name", () => {
    expect(K.parseTranscript([call(1, 10000, 100, [["a", "Read"]]), result([["a", "x".repeat(900)]]), call(2, 8000, 0)]).growthBySource).toEqual({});
    const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: false, compactMetadata: { trigger: "auto" } });
    const all = [call(1, 10000, 100, [["a", "Read"]]), result([["a", "x".repeat(900)]]), call(2, 20000, 100), boundary, said("go"),
      call(3, 5000, 100, [["b", "Bash"]]), result([["b", "y".repeat(10)]]), call(4, 6000, 0)];
    expect(K.parseTranscript(all.slice(0, 3)).growthBySource).toEqual({ output: 100, Read: 9900 });
    expect(K.parseTranscript(all).growthBySource).toEqual({ output: 100, Bash: 900 });
    const side = [call(1, 10000, 0, [["a", "Read"]]), result([["a", "x".repeat(500)]], { isSidechain: true }), result([["zz", "y".repeat(500)]]), call(2, 11000, 0)];
    expect(K.parseTranscript(side).growthBySource).toEqual({ other: 1000 });
  });

  it("the growth continues over a tail cut anywhere: between a call and its result, and between a result and the next turn", () => {
    const all = [said("go"), call(1, 10000, 200, [["t1", "Read"], ["t2", "Bash"]]), attached("r".repeat(50)), result([["t1", "x".repeat(4000)]]), result([["t2", "y".repeat(700)]]),
      call(2, 15000, 300, [["t3", "Agent"]]), call(2, 15000, 300, [["t4", "Read"]]), result([["t3", "z".repeat(2000)]]), result([["t4", "w".repeat(10)]]), said("more"), call(3, 18000, 40)];
    const whole = K.parseTranscript(all);
    expect(Object.keys(whole.growthBySource).sort()).toEqual(["Agent", "Bash", "Read", "other", "output", "you"]);
    for (let cut = 1; cut < all.length; cut++) expect(K.parseTranscript(all.slice(cut), K.parseTranscript(all.slice(0, cut)))).toEqual(whole);
  });
});

/** An assistant turn of its own (turn() with output_tokens) whose content is the given tool calls, [id, name] each. */
function call(i, tokens, output, tools = []) {
  const e = JSON.parse(turn(i, tokens, {}, { output_tokens: output }));
  e.message.content = tools.map(([id, name]) => ({ type: "tool_use", id, name, input: {} }));
  return JSON.stringify(e);
}
/** A user entry with tool results, [tool_use_id, content] each. */
function result(pairs, extra = {}) {
  return JSON.stringify({ type: "user", isSidechain: false, ...extra, message: { role: "user", content: pairs.map(([id, content]) => ({ type: "tool_result", tool_use_id: id, content })) } });
}
function said(content, extra = {}) { return JSON.stringify({ type: "user", isSidechain: false, ...extra, message: { role: "user", content } }); }
function attached(content) { return JSON.stringify({ type: "attachment", isSidechain: false, attachment: { type: "date" }, rendered: [{ content }] }); }

/** One assistant entry that is a turn of its own (own message.id) with the given input count; `usage` overrides fields of the usage. */
function turn(i, tokens, extra = {}, usage = {}) {
  return JSON.stringify({ parentUuid: `u${i}`, isSidechain: false, type: "assistant", uuid: `a${i}`, timestamp: `2026-10-22T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
    message: { id: `msg_${i}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "." }],
      usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, ...usage } }, ...extra });
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
  it("green below 100 000, yellow below 125 000, orange up to and including 150 000, red above, null without a number", () => {
    expect(K.zone(0)).toBe("green");
    expect(K.zone(99999)).toBe("green");
    expect(K.zone(100000)).toBe("yellow");
    expect(K.zone(124999)).toBe("yellow");
    expect(K.zone(125000)).toBe("orange");
    expect(K.zone(150000)).toBe("orange");
    expect(K.zone(150001)).toBe("red");
    expect(K.zone(null)).toBeNull();
    expect(K.zone(NaN)).toBeNull();
  });
});

describe("projectSlug", () => {
  it("replaces slashes and every other non-alphanumeric character with a dash, like Claude Code", () => {
    expect(K.projectSlug("/Users/frode/Dev/my-project")).toBe("-Users-frode-Dev-my-project");
    expect(K.projectSlug("/Users/frode/.claude/skills")).toBe("-Users-frode--claude-skills");
  });

  it("a Windows path gives the folder name seen on Windows: the colon and every backslash become a dash, the drive letter keeps its case", () => {
    expect(K.projectSlug("C:\\Users\\frode\\Dev\\Repo")).toBe("C--Users-frode-Dev-Repo");
    expect(K.projectSlug("c:\\Develop\\my-project\\.claude\\worktrees\\x")).toBe("c--Develop-my-project--claude-worktrees-x");
  });
});

describe("inFolder", () => {
  it("backslashes, mixed separators and a trailing separator compare like forward slashes", () => {
    expect(K.inFolder("C:\\Dev\\Repo", "C:\\Dev\\Repo", "win32")).toBe(true);
    expect(K.inFolder("C:\\Dev\\Repo\\.claude\\worktrees\\x", "C:\\Dev\\Repo", "win32")).toBe(true);
    expect(K.inFolder("C:/Dev/Repo\\sub", "C:\\Dev\\Repo\\", "win32")).toBe(true);
    expect(K.inFolder("C:\\Dev\\Repo2", "C:\\Dev\\Repo", "win32")).toBe(false);
  });

  it("on Windows the drive letter and the rest compare case-insensitively, elsewhere not", () => {
    expect(K.inFolder("C:\\Dev\\Repo\\sub", "c:\\Dev\\Repo", "win32")).toBe(true);
    expect(K.inFolder("c:\\dev\\repo", "C:\\Dev\\Repo", "win32")).toBe(true);
    expect(K.inFolder("/Users/frode/Repo", "/users/frode/repo", "linux")).toBe(false);
    expect(K.inFolder("/Users/frode/Repo/sub", "/Users/frode/Repo/", "linux")).toBe(true);
  });
});

describe("projectName", () => {
  it("is the last part of the path, with forward slashes or backslashes", () => {
    expect(K.projectName("/Users/frode/Dev/my-project")).toBe("my-project");
    expect(K.projectName("c:\\Develop\\my-project")).toBe("my-project");
    expect(K.projectName("C:\\Develop\\my-project\\")).toBe("my-project");
  });
});

describe("readRegistry", () => {
  it("returns the entries of live processes and skips dead ones, invalid JSON and other files", () => {
    const r = K.readRegistry(`${FIX}registry`, (pid) => pid === 1303 || pid === 5555);
    expect(r.error).toBeNull();
    expect(r.sessions.map((s) => s.pid)).toEqual([1303, 5555]);
    expect(r.sessions[0]).toMatchObject({ sessionId: "aaaa-1", cwd: "/Users/frode/Dev/my-project", status: "busy", name: "my-project-08" });
    expect(r.sessions[1].name).toBeNull();
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

describe("seriesFor", () => {
  const state = { series: [10, 20, 30, 5, 40, 2], outputSeries: [1, 2, 3, 4, 5, 6], thinkingSeries: [0, 1, 0, 1, 0, 1],
    compactions: [{ at: 1, trigger: "auto" }, { at: 3, trigger: "manual" }], baselineAt: 3 };

  it("without a limit it gives every turn, and the dips without the turns of a compaction", () => {
    expect(K.seriesFor(state)).toEqual({ series: [10, 20, 30, 5, 40, 2], outputSeries: [1, 2, 3, 4, 5, 6], thinkingSeries: [0, 1, 0, 1, 0, 1],
      compactions: [{ at: 1, trigger: "auto" }, { at: 3, trigger: "manual" }], dips: [5], baselineAt: 3 });
  });

  it("cut to the last turns, the compactions and baselineAt move with the cut, and a cut one drops out or becomes null", () => {
    expect(K.seriesFor(state, 4)).toEqual({ series: [30, 5, 40, 2], outputSeries: [3, 4, 5, 6], thinkingSeries: [0, 1, 0, 1],
      compactions: [{ at: 1, trigger: "manual" }], dips: [3], baselineAt: 1 });
    expect(K.seriesFor(state, 2)).toMatchObject({ series: [40, 2], compactions: [], baselineAt: null });
  });

  it("a state without the fields (older core, no transcript) gives empty lists and no baselineAt", () => {
    expect(K.seriesFor({})).toEqual({ series: [], outputSeries: [], thinkingSeries: [], compactions: [], dips: [], baselineAt: null });
  });
});

describe("summaryText", () => {
  it("zone only: the zone and nothing else", () => {
    expect(K.summaryText({ zone: "green" }, null)).toBe("Green zone.");
  });

  it("with the compactions of the session, one or more", () => {
    expect(K.summaryText({ zone: "red", compactionCount: 1 }, null)).toBe("Red zone after 1 compaction.");
    expect(K.summaryText({ zone: "orange", compactionCount: 2, baseline: 60000, baselineCause: "compaction" }, 45000))
      .toBe("Orange zone after 2 compactions; this segment started at 60K, a fresh session here typically starts at ~45K.");
  });

  it("the segment's start: \"this segment\" after a compaction, \"the session\" from the start", () => {
    expect(K.summaryText({ zone: "red", compactionCount: 1, baseline: 168600, baselineCause: "compaction" }, null)).toBe("Red zone after 1 compaction; this segment started at 169K.");
    expect(K.summaryText({ zone: "yellow", compactionCount: 0, baseline: 29589, baselineCause: "start" }, null)).toBe("Yellow zone; the session started at 30K.");
  });

  it("with a median the typical fresh start follows, without one (null) the clause is left out", () => {
    expect(K.summaryText({ zone: "red", compactionCount: 1, baseline: 168600, baselineCause: "compaction" }, 29000))
      .toBe("Red zone after 1 compaction; this segment started at 169K, a fresh session here typically starts at ~29K.");
    expect(K.summaryText({ zone: "green" }, 40500)).toBe("Green zone, a fresh session here typically starts at ~41K.");
    expect(K.summaryText({ zone: "green", baseline: 12000, baselineCause: "start" }, null)).toBe("Green zone; the session started at 12K.");
  });

  it("no count gives no zone, and no advice or threshold is ever added", () => {
    expect(K.summaryText({ zone: null, compactionCount: 0, baseline: null, turns: 3 }, 40000)).toBe("No token count yet, so no zone.");
    expect(K.summaryText({ zone: null, compactionCount: 0, baseline: null, turns: 0 }, 40000)).toBe("No turns yet, so no count and no zone.");
    const all = ["green", "yellow", "orange", "red"].map((zone) => K.summaryText({ zone, compactionCount: 3, baseline: 50000, baselineCause: "start" }, 40000));
    for (const text of all) expect(text).not.toMatch(/clear|compact |break|fresh session now|should|phase/i);
  });
});

describe("growthRows", () => {
  it("largest first, equal counts by name, each with its share of the sum", () => {
    const rows = K.growthRows({ output: 10000, Read: 40000, Bash: 40000, you: 10000 });
    expect(rows.map((r) => r.source)).toEqual(["Bash", "Read", "output", "you"]);
    expect(rows.map((r) => r.tokens)).toEqual([40000, 40000, 10000, 10000]);
    expect(rows.map((r) => r.share)).toEqual([0.4, 0.4, 0.1, 0.1]);
  });

  it("zero, negative and non-numbers are left out; nothing gives no rows", () => {
    expect(K.growthRows({ Read: 0, Bash: -5, Grep: "x", Edit: NaN, you: 300 })).toEqual([{ source: "you", tokens: 300, share: 1 }]);
    expect(K.growthRows({})).toEqual([]);
    expect(K.growthRows(null)).toEqual([]);
  });

  it("a row carries the source, the tokens and the share only: the estimate's caveat is stated once under the chart, not per bar", () => {
    for (const row of K.growthRows({ Read: 41200, output: 9600, mcp__royktest__browser_click: 700 })) expect(Object.keys(row)).toEqual(["source", "tokens", "share"]);
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
  const H1 = 3600000, M5 = 300000;
  const transcripts = {
    old: tail(170500, "2026-10-21T21:20:00.000Z", { cacheTtlMs: H1, cacheRead: 160000, cacheCreated: 10000 }), // 1 h 20 min ago → dimmed, red, cold
    new: tail(143002, "2026-10-21T22:28:00.000Z", { model: "claude-fable-5-1", cacheTtlMs: H1, cacheRead: 142000, cacheCreated: 1000 }), // 12 min ago, orange, warm
    busy: tail(20000, "2026-10-21T20:00:00.000Z", { cacheTtlMs: M5, cacheRead: 0, cacheCreated: 19000 }), // busy, although the last turn is old; cold
    other: tail(5000, "2026-10-21T22:39:30.000Z", { cacheTtlMs: M5, cacheRead: 4000, cacheCreated: 1000 }), // 30 s ago, warm for 4.5 min
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
    expect(fresh).toMatchObject({ tokens: 143002, zone: "orange", modelShort: "Fable 5.1", turns: 3,
      sinceMs: 12 * 60000, busy: false, dimmed: false, project: "my-project", title: "T" });
    expect(old).toMatchObject({ zone: "red", dimmed: true, sinceMs: 80 * 60000, modelShort: "Opus 5.5" });
    expect(busy).toMatchObject({ busy: true, zone: "green", dimmed: true });
    expect(without).toMatchObject({ tokens: null, zone: null, modelShort: null, title: null, turns: 0, sinceMs: null, dimmed: false, name: null });
  });

  it("name is the registry's, for the panel's title when the transcript has none; null when missing", () => {
    const named = [{ ...reg(1, "a", MINE, "idle"), name: "my-project-08" }, { ...reg(2, "b", MINE, "idle"), name: "" }];
    const r = K.buildSessions({ registry: named, transcripts: {}, now: NOW, workspaceFolders: [MINE] });
    expect(Object.fromEntries(r.sessions.map((s) => [s.sessionId, s.name]))).toEqual({ a: "my-project-08", b: null });
  });

  it("startedAt is the registry's epoch ms as ISO, null when missing or not a number", () => {
    const withStart = [{ ...reg(1, "a", MINE, "idle"), startedAt: 1792603960396 }, { ...reg(2, "b", MINE, "idle"), startedAt: "soon" }, reg(3, "c", MINE, "idle")];
    const r = K.buildSessions({ registry: withStart, transcripts: {}, now: NOW, workspaceFolders: [MINE], all: false });
    expect(Object.fromEntries(r.sessions.map((s) => [s.sessionId, s.startedAt]))).toEqual({ a: "2026-10-21T17:32:40.396Z", b: null, c: null });
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

  it("the compactions pass through, and a dip at the turn of a compaction is not listed again", () => {
    const compactions = [{ at: 2, trigger: "auto", preTokens: 150000, postTokens: 50000, durationMs: 1000 }];
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: tail(143002, NOW, { series: [140000, 150000, 55000, 143002, 20000], compactions }) },
      now: NOW, workspaceFolders: [MINE], all: false });
    const fresh = r.sessions.find((s) => s.sessionId === "new");
    expect(fresh.compactions).toEqual(compactions);
    expect(fresh.dips).toEqual([4]);
    expect(r.sessions.find((s) => s.sessionId === "without").compactions).toEqual([]);
  });

  it("the output fields pass through; without a transcript the series are empty and the totals and the effort unknown", () => {
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: tail(143002, NOW, { outputSeries: [5, 7], thinkingSeries: [1, 2], outputTotal: 12, thinkingTotal: 3, effort: "high" }) },
      now: NOW, workspaceFolders: [MINE], all: false });
    expect(r.sessions.find((s) => s.sessionId === "new")).toMatchObject({ outputSeries: [5, 7], thinkingSeries: [1, 2], outputTotal: 12, thinkingTotal: 3, effort: "high" });
    expect(r.sessions.find((s) => s.sessionId === "without")).toMatchObject({ outputSeries: [], thinkingSeries: [], outputTotal: null, thinkingTotal: null, effort: null });
  });

  it("the baseline fields pass through, and the header has the median baseline of the sessions whose segment is a start", () => {
    const at = (baseline, baselineCause) => tail(143002, NOW, { baseline, baselineAt: 0, baselineCause });
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: at(62000, "start"), old: at(30000, "compaction"), busy: at(40000, "start") },
      now: NOW, workspaceFolders: [MINE], all: false });
    expect(r.sessions.find((s) => s.sessionId === "new")).toMatchObject({ baseline: 62000, baselineAt: 0, baselineCause: "start" });
    expect(r.sessions.find((s) => s.sessionId === "without")).toMatchObject({ baseline: null, baselineAt: null, baselineCause: null });
    // the compaction (30K) is left out: the median of 40K and 62K
    expect(r).toMatchObject({ baselineMedian: 51000, baselineSessions: 2 });
    const odd = K.buildSessions({ registry, transcripts: { ...transcripts, new: at(62000, "start"), old: at(70000, "start"), busy: at(40000, "start") },
      now: NOW, workspaceFolders: [MINE], all: false });
    expect(odd).toMatchObject({ baselineMedian: 62000, baselineSessions: 3 });
    expect(K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: false })).toMatchObject({ baselineMedian: null, baselineSessions: 0 });
  });

  it("the growth by source passes through, an empty object without a transcript", () => {
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: tail(143002, NOW, { growthBySource: { Read: 41200, output: 9600 } }) },
      now: NOW, workspaceFolders: [MINE], all: false });
    expect(r.sessions.find((s) => s.sessionId === "new").growthBySource).toEqual({ Read: 41200, output: 9600 });
    expect(r.sessions.find((s) => s.sessionId === "without").growthBySource).toEqual({});
  });

  it("the growth as rows for the detail chart, largest first; none without a transcript", () => {
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: tail(143002, NOW, { growthBySource: { output: 9600, Read: 41200 } }) },
      now: NOW, workspaceFolders: [MINE], all: false });
    expect(r.sessions.find((s) => s.sessionId === "new").growth.map((g) => [g.source, g.tokens])).toEqual([["Read", 41200], ["output", 9600]]);
    expect(r.sessions.find((s) => s.sessionId === "without").growth).toEqual([]);
  });

  it("the list keeps the last 200 turns of a longer session; compactionCount and the sentence count the whole session's compactions", () => {
    const series = Array.from({ length: 233 }, (_, i) => 1000 * (i + 1));
    const long = tail(233000, NOW, { turns: 233, series, outputSeries: series.map(() => 5), thinkingSeries: series.map(() => 1),
      compactions: [{ at: 10, trigger: "auto" }, { at: 220, trigger: "manual" }], baseline: 221000, baselineAt: 220, baselineCause: "compaction" });
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: long }, now: NOW, workspaceFolders: [MINE], all: false });
    const s = r.sessions.find((x) => x.sessionId === "new");
    expect(s.series.length).toBe(200);
    expect(s.series[0]).toBe(34000);
    expect(s.outputSeries.length).toBe(200);
    expect(s.compactions).toEqual([{ at: 187, trigger: "manual" }]);
    expect(s.baselineAt).toBe(187);
    expect(s.compactionCount).toBe(2);
    expect(s.summary).toBe("Red zone after 2 compactions; this segment started at 221K.");
    expect(r.sessions.find((x) => x.sessionId === "without")).toMatchObject({ compactionCount: 0, summary: "No turns yet, so no count and no zone." });
  });

  it("the sentence of every session takes the list's median of the fresh starts", () => {
    const at = (baseline, baselineCause) => tail(143002, NOW, { baseline, baselineAt: 0, baselineCause });
    const r = K.buildSessions({ registry, transcripts: { ...transcripts, new: at(62000, "start"), old: at(30000, "compaction"), busy: at(40000, "start") },
      now: NOW, workspaceFolders: [MINE], all: false });
    expect(r.baselineMedian).toBe(51000);
    expect(r.sessions.find((s) => s.sessionId === "old").summary).toBe("Orange zone; this segment started at 30K, a fresh session here typically starts at ~51K.");
    expect(r.sessions.find((s) => s.sessionId === "new").summary).toBe("Orange zone; the session started at 62K, a fresh session here typically starts at ~51K.");
  });

  it("the count per zone covers the listed sessions in all four zones, unknown is not counted, and with all projects everything shown is counted", () => {
    expect(K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: false }).zoneCounts).toEqual({ green: 1, yellow: 0, orange: 1, red: 1 });
    expect(K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: true }).zoneCounts).toEqual({ green: 2, yellow: 0, orange: 1, red: 1 });
    const withYellow = { ...transcripts, without: tail(110000, NOW) };
    expect(K.buildSessions({ registry, transcripts: withYellow, now: NOW, workspaceFolders: [MINE], all: false }).zoneCounts).toEqual({ green: 1, yellow: 1, orange: 1, red: 1 });
    expect(K.buildSessions({ registry: [], transcripts: {}, now: NOW, workspaceFolders: [MINE], all: false }).zoneCounts).toEqual({ green: 0, yellow: 0, orange: 0, red: 0 });
  });

  // the prompt cache per session: hit share of the last turn, the deadline the cache goes cold, and the state now
  it("per session: hit share of the last turn, the cold deadline from the last turn plus the TTL, the time left, and warm or cold now", () => {
    const r = K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: true });
    const by = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));
    expect(by.new).toMatchObject({ cacheTtlMs: H1, cacheRead: 142000, cacheCreated: 1000, coldAt: "2026-10-21T23:28:00.000Z", coldInMs: 48 * 60000, cacheState: "warm" });
    expect(by.new.hitShare).toBeCloseTo(142000 / 143002, 6);
    expect(by.old).toMatchObject({ coldAt: "2026-10-21T22:20:00.000Z", coldInMs: -20 * 60000, cacheState: "cold" });
    expect(by.busy).toMatchObject({ cacheTtlMs: M5, coldAt: "2026-10-21T20:05:00.000Z", cacheState: "cold", hitShare: 0 });
    expect(by.other).toMatchObject({ coldInMs: 4.5 * 60000, cacheState: "warm" });
    expect(by.other.hitShare).toBeCloseTo(0.8, 6);
    expect(by.without).toMatchObject({ cacheTtlMs: null, cacheRead: null, cacheCreated: null, hitShare: null, coldAt: null, coldInMs: null, cacheState: null });
  });

  it("a session at exactly the deadline is cold, a transcript without a TTL (older Claude Code) has no deadline, and a hit share needs a count", () => {
    const at = tail(100000, "2026-10-21T21:40:00.000Z", { cacheTtlMs: H1, cacheRead: 90000, cacheCreated: 0 }); // 21:40 + 1 h = NOW
    const noTtl = tail(100000, NOW, { cacheRead: 90000, cacheCreated: 0 });
    const noCount = { title: "T", cacheTtlMs: H1, cacheRead: 0, cacheCreated: 0 };
    const r = K.buildSessions({ registry: [reg(1, "at", MINE, "idle"), reg(2, "noTtl", MINE, "idle"), reg(3, "noCount", MINE, "idle")],
      transcripts: { at, noTtl, noCount }, now: NOW, workspaceFolders: [MINE], all: false });
    const by = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));
    expect(by.at).toMatchObject({ coldInMs: 0, cacheState: "cold" });
    expect(by.noTtl).toMatchObject({ cacheTtlMs: null, cacheRead: 90000, hitShare: 0.9, coldAt: null, coldInMs: null, cacheState: null });
    expect(by.noCount).toMatchObject({ tokens: null, hitShare: null, coldAt: null, cacheState: null });
  });

  it("the header counts warm and cold over the listed sessions; sessions without a TTL are not counted", () => {
    expect(K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: false }).cacheCounts).toEqual({ warm: 1, cold: 2 });
    expect(K.buildSessions({ registry, transcripts, now: NOW, workspaceFolders: [MINE], all: true }).cacheCounts).toEqual({ warm: 2, cold: 2 });
    expect(K.buildSessions({ registry: [], transcripts: {}, now: NOW, workspaceFolders: [MINE], all: false }).cacheCounts).toEqual({ warm: 0, cold: 0 });
  });

  it("a session in a subfolder of the workspace folder belongs to the window, one in a folder with the same prefix does not", () => {
    const r = K.buildSessions({
      registry: [reg(1, "below", `${MINE}/packages/app`, "idle"), reg(2, "prefix", `${MINE}2`, "idle")],
      transcripts: {}, now: NOW, workspaceFolders: [MINE], all: false,
    });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["below"]);
  });

  it("Windows paths: a worktree below the workspace folder belongs to the window, and the project is the last folder name", () => {
    const r = K.buildSessions({
      registry: [reg(1, "root", "c:\\Develop\\my-project", "idle"), reg(2, "tree", "c:\\Develop\\my-project\\.claude\\worktrees\\x", "idle"),
        reg(3, "elsewhere", "c:\\Develop\\other", "idle")],
      transcripts: {}, now: NOW, workspaceFolders: ["c:\\Develop\\my-project"], all: false,
    });
    expect(r.sessions.map((s) => [s.sessionId, s.project])).toEqual([["root", "my-project"], ["tree", "x"]]);
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
      expect(second.sessions[0]).toMatchObject({ turns: 2, tokens: 143002, model: "claude-opus-5-5", cacheTtlMs: 3600000, cacheRead: 142000, cacheCreated: 1000, cacheState: "cold" });
      expect(second.cacheCounts).toEqual({ warm: 0, cold: 1 }); // the fixture's last turn is 2026-10-21, long past its hour
      expect(typeof second.generatedAt).toBe("string");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("read({ full: true }) forgets the parsed state and the remembered folders, and reads every transcript from its first byte", () => {
    const { dir, file } = rig();
    try {
      const reader = new K.SessionReader(dir, { alive: (pid) => pid === 1303 });
      reader.read({ workspaceFolders: [MINE], all: false });
      // a stale parsed state (as after a core change or a bug): with no new bytes the incremental read keeps it
      reader.cache.get(file).state.tokens = 1;
      reader.found.set("stale", "/nowhere");
      const incremental = reader.read({ workspaceFolders: [MINE], all: false });
      expect(incremental.sessions[0].tokens).toBe(1);
      const full = reader.read({ workspaceFolders: [MINE], all: false, full: true });
      expect(full.sessions[0]).toMatchObject({ sessionId: "aaaa-1", turns: 1, tokens: 40004 });
      expect(reader.cache.get(file).end).toBe(Buffer.byteLength(all.slice(0, 5).join("\n") + "\n"));
      expect(reader.found.has("stale")).toBe(false);
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

  it("when the slug folder is missing, the folder in projects/ that holds the transcript is used and remembered", () => {
    const { dir } = rig({ withProjectFolder: false });
    try {
      const other = path.join(dir, "projects", "renamed-by-claude-code");
      mkdirSync(other, { recursive: true });
      mkdirSync(path.join(dir, "projects", "unrelated"));
      writeFileSync(path.join(other, "aaaa-1.jsonl"), all.join("\n") + "\n");
      const reader = new K.SessionReader(dir, { alive: (pid) => pid === 1303 });
      const result = reader.read({ workspaceFolders: [MINE], all: false });
      expect(result.errors).toEqual([]);
      expect(result.sessions[0]).toMatchObject({ sessionId: "aaaa-1", turns: 2, tokens: 143002 });
      expect(result.projectFolders).toEqual([other]);
      expect(reader.found.get("aaaa-1")).toBe(other);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("detail() gives every turn of a session from the last read while the list keeps 200; baselineAt indexes the full series", () => {
    const { dir, file } = rig();
    try {
      const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: false, compactMetadata: { trigger: "auto", preTokens: 9000, postTokens: 1000 } });
      const long = [];
      for (let i = 1; i <= 230; i++) { if (i === 11) long.push(boundary); long.push(turn(i, i === 11 ? 1000 : 1000 * i)); }
      writeFileSync(file, long.join("\n") + "\n");
      const reader = new K.SessionReader(dir, { alive: (pid) => pid === 1303 });
      const list = reader.read({ workspaceFolders: [MINE], all: false });
      expect(list.sessions[0]).toMatchObject({ turns: 230, compactions: [], compactionCount: 1, baselineAt: null });
      expect(list.sessions[0].series.length).toBe(200);
      const d = reader.detail("aaaa-1");
      expect(d.turns).toBe(230);
      expect(d.series.length).toBe(230);
      expect(d.outputSeries.length).toBe(230);
      expect(d.compactions).toEqual([{ at: 10, trigger: "auto", preTokens: 9000, postTokens: 1000, durationMs: null }]);
      expect(d.dips).toEqual([]); // the fall at turn 11 is the compaction, not a dip
      expect(d.baselineAt).toBe(10);
      expect(d.series[d.baselineAt]).toBe(list.sessions[0].baseline);
      // new bytes without a read: the detail stays the last read's, the same transcript as the list
      appendFileSync(file, turn(231, 231000) + "\n");
      expect(reader.detail("aaaa-1").turns).toBe(230);
      reader.read({ workspaceFolders: [MINE], all: false });
      expect(reader.detail("aaaa-1").series.length).toBe(231);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("detail() is null for a session the last read did not parse: unknown, dead, or without a transcript", () => {
    const { dir, file } = rig();
    try {
      const reader = new K.SessionReader(dir, { alive: (pid) => pid === 1303 });
      expect(reader.detail("aaaa-1")).toBeNull(); // nothing read yet
      reader.read({ workspaceFolders: [MINE], all: false });
      expect(reader.detail("aaaa-1")).toMatchObject({ turns: 1, series: [40004] });
      expect(reader.detail("dead")).toBeNull();
      expect(reader.detail("nope")).toBeNull();
      rmSync(file);
      reader.read({ workspaceFolders: [MINE], all: false });
      expect(reader.detail("aaaa-1")).toBeNull();
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
