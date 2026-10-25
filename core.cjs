// core.cjs — pure functions behind the "Claude Context" panel. No VS Code dependency: the extension
// hosts (extension.js, server.cjs) and the tests (test/core.test.js) all require this file. The transcript format is
// Claude Code's internal one and may change between versions, so a missing field yields null
// ("unknown"), never an error.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Quality warnings, not the window limit: absolute token counts from Matt Pocock's smart/dumb zone, checked against
// his primary sources on 2026-10-25. He has two zones with a gradual decline between them, so the panel has three:
// green is his smart zone, up to his newest figure, "~150k tokens on state-of-the-art models" (mattpocock/skills,
// ask-matt/SKILL.md and PHASE-BOUNDARIES.md, 2026-08-05); orange is the start of the dumb zone. His dictionary's
// earlier band, where the dumb zone "commonly begins around 125K-150K tokens — though this is debated"
// (dictionary/Smart zone.md, since 2026-06-05), is the same boundary, so it is not a line of its own. 200K is the
// panel's own line: he gives no figure for how deep the dumb zone goes, and measurements find a gradient, not a cliff
// (Chroma, "Context Rot", July 2025; Anthropic on context engineering, September 2025).
const ORANGE_FROM = 150000, RED_ABOVE = 200000;
// A session without a turn for an hour is dimmed. One that is neither busy nor waiting and had neither a turn nor its
// process start for an hour is abandoned, and the panel folds it away: a closed VS Code chat tab keeps its process (NOTES.md,
// "Closed chat tabs") and nothing tells it from an open tab, so a quiet hour is the only sign there is. The start
// counts because a tab reopened on an old session spawns a new process. An hour is also the longer cache TTL.
const DIM_AFTER_MS = 60 * 60 * 1000;
// The prompt cache's two TTLs. Every turn re-sends the whole context; while the cache is warm the context is
// read from it, and the cache is refreshed on every use, so the deadline is the last turn plus the TTL.
// Prices (platform.claude.com/docs/en/docs/build-with-claude/prompt-caching, read 2026-10-22): a 5-minute
// write costs 1.25× input, a 1-hour write 2×, a read 0.1× (0.025× on Fable and Mythos 5.1, 0.05× on Opus and
// Sonnet 5.5). A session that went cold rewrites its whole context on the next turn.
const TTL_1H_MS = 60 * 60 * 1000, TTL_5M_MS = 5 * 60 * 1000;
const SERIES_MAX = 200; // the list keeps the last 200 turns per session, so its payload stays small; the detail view asks for all of them
const DIP_BELOW = 0.7; // a turn is a dip when its context is below 70 % of the previous turn's
// What an image weighs against text when a turn's growth is split by length. Measured in the owner's transcripts
// on 2026-10-23: one image grew the context by a median 1 643 tokens (113 gaps with an image and little else),
// text by one token per 2.06 characters (1 059 gaps without images). The vision docs' rule, ⌈w/28⌉ × ⌈h/28⌉ up
// to 4 784 tokens, needs the dimensions, which the transcript does not have.
const IMAGE_CHARS = 3500;

/** The folder name Claude Code gives a project under projects/: every non-alphanumeric char becomes "-". */
function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Zone for a token count: green below 150K, orange up to and including 200K, red above, null when unknown. */
function zone(tokens) {
  if (!Number.isFinite(tokens)) return null;
  return tokens < ORANGE_FROM ? "green" : tokens <= RED_ABOVE ? "orange" : "red";
}

const SESSION_ID = /^[\w-]+$/; // a UUID as Claude Code writes it; never a path

/**
 * The registry of Claude sessions: one JSON file per process in Claude Code's sessions/ folder. Only
 * entries where alive(pid) is true are kept (a file can linger after a process died abruptly). The pid
 * must be a positive integer: kill(0, 0) signals the whole process group on POSIX, so it would read as
 * alive. A sessionId that is not a plain id is null, since it becomes a file name under projects/.
 */
function readRegistry(dir, alive) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { sessions: [], error: `Registry folder not found: ${dir}` }; }
  const sessions = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let entry;
    try { entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const pid = Number(entry.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) continue;
    sessions.push({
      pid, sessionId: typeof entry.sessionId === "string" && SESSION_ID.test(entry.sessionId) ? entry.sessionId : null,
      cwd: entry.cwd || null, status: entry.status || null, startedAt: entry.startedAt || null,
      name: typeof entry.name === "string" && entry.name ? entry.name : null, // "my-project-08", derived by Claude Code
    });
  }
  return { sessions, error: null };
}

/**
 * Whole lines from a transcript: from byte offset `from`, or the last `bytes` bytes with the
 * truncated first line dropped. `end` is the offset after the last newline, so a line still being
 * written is read again next time. A `from` beyond the end means the file was rewritten shorter:
 * it is read from the start and `restarted` is true, so the caller drops its previous state.
 */
function readTail(file, { from, bytes } = {}) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return { lines: [], end: 0, missing: true, restarted: false }; }
  try {
    const size = fs.fstatSync(fd).size;
    const restarted = Number.isFinite(from) && from > size;
    const start = restarted ? 0 : Number.isFinite(from) ? from : Math.max(0, size - (bytes || 0));
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], end: start, missing: false, restarted };
    let text = buf.subarray(0, lastNewline + 1).toString("utf8");
    if (start > 0 && !Number.isFinite(from)) text = text.slice(text.indexOf("\n") + 1); // cut mid-line
    return { lines: text.split("\n").filter(Boolean), end: start + lastNewline + 1, missing: false, restarted };
  } finally { fs.closeSync(fd); }
}

/**
 * The last assistant entry with usage outside a sidechain (subagent) gives tokens, model and timestamp,
 * and the prompt cache's counters of that turn (`cacheRead`, `cacheCreated`). `cacheTtlMs` is the TTL of
 * the last turn that created cache, read from `usage.cache_creation` (ephemeral_1h_input_tokens or
 * ephemeral_5m_input_tokens above zero); a turn that created nothing says nothing, and it is null until seen.
 * A turn is one API call: Claude Code writes one entry per content block of a response, all sharing
 * message.id, so turns are counted per id. `series` is the token count per turn, oldest first, over the whole
 * transcript (the list payload keeps the last SERIES_MAX, see seriesFor). `compactions` are the compact_boundary entries Claude Code writes, each at `at`, the
 * index in `series` of the first turn after it, with the trigger ("auto", "manual") and the counts before and
 * after; a /clear starts a new transcript, so it never shows here. `outputSeries` and `thinkingSeries` are the
 * output tokens per turn and the thinking part of them (usage.output_tokens, output_tokens_details.thinking_tokens),
 * aligned with `series` and counted once per turn (every block of a response carries the same counters);
 * `outputTotal` and `thinkingTotal` sum them over the whole transcript, and `effort` is the last turn's.
 * `baseline` is the token count of the first turn of the current segment: the fixed load (CLAUDE.md, memory,
 * skill and tool listings) plus the first message. A segment starts with the transcript (a new session or a
 * /clear) or at a compaction, which `baselineCause` says ("start", "compaction"); later blocks of that turn
 * update it like the series. `baselineAt` is the segment's first index in `series`. A state parsed by an older
 * core gets no baseline: its first turn is unknown.
 * `growthBySource` estimates where the segment's context went since its first turn. The growth from one turn
 * to the next (a fall is skipped) goes first to "output", up to the previous turn's output_tokens (what the
 * model wrote is read back as input), and the rest is split by length over what entered between the two
 * turns: each tool result under its tool's name, the user's text as "you", meta entries and rendered
 * attachments as "other" (all of it when nothing was seen). Token counts per result are not in the transcript,
 * so the split is an estimate; earlier thinking stays in the context, so "output" is not overstated (NOTES.md,
 * "Where the context grows"). The open tool calls (id → name) and the characters since the last turn are
 * hidden state. The title is the last ai-title entry, else
 * the first user message (meta entries and tool results skipped) collapsed to one line, else the first local
 * command ("/context all": a system entry, subtype local_command, never its output). With `previous`, the
 * lines are parsed as the continuation of an already parsed transcript, so the host reads only the new bytes.
 */
function parseTranscript(lines, previous) {
  const p = previous || {};
  let tokens = p.tokens ?? null, model = p.model ?? null, lastTurn = p.lastTurn ?? null;
  let cacheTtlMs = p.cacheTtlMs ?? null, cacheRead = p.cacheRead ?? null, cacheCreated = p.cacheCreated ?? null;
  // `title` is the shown title, composed below; the continuation needs the ai-title alone, so a command's title gives way to a later user message
  let title = ("aiTitle" in p ? p.aiTitle : p.title) || null, firstUser = p.firstUser || null, firstCommand = p.firstCommand || null;
  let turns = p.turns || 0, lastId = p.lastId || null;
  let pendingCompaction = p.pendingCompaction || null;
  let outputTotal = p.outputTotal || 0, thinkingTotal = p.thinkingTotal || 0, effort = p.effort ?? null;
  let turnOutput = p.turnOutput || 0, turnThinking = p.turnThinking || 0;
  let baseline = p.baseline ?? null, baselineAt = p.baselineAt ?? null, baselineCause = p.baselineCause ?? null, baselineId = p.baselineId ?? null;
  let growthBySource = { ...p.growthBySource }, pendingInput = { ...p.pendingInput };
  const toolNames = { ...p.toolNames };
  const enter = (source, chars) => { if (chars > 0) pendingInput[source] = (pendingInput[source] || 0) + chars; };
  const series = Array.isArray(p.series) ? p.series.slice() : [];
  const outputSeries = Array.isArray(p.outputSeries) ? p.outputSeries.slice() : [];
  const thinkingSeries = Array.isArray(p.thinkingSeries) ? p.thinkingSeries.slice() : [];
  const compactions = Array.isArray(p.compactions) ? p.compactions.map((c) => ({ ...c })) : [];
  for (const line of lines) {
    const entry = parseEntry(line);
    if (!entry || entry.isSidechain) continue;
    if (entry.type === "system" && entry.subtype === "compact_boundary") { pendingCompaction = compaction(entry.compactMetadata); continue; }
    if (entry.type === "system" && entry.subtype === "local_command") { if (!firstCommand && /<command-name>/.test(entry.content)) firstCommand = userText(entry.content); continue; }
    if (entry.type === "ai-title") { if (entry.aiTitle) title = String(entry.aiTitle); continue; }
    if (entry.type === "attachment") { if (Array.isArray(entry.rendered)) for (const r of entry.rendered) enter("other", contentChars(r && r.content)); continue; }
    if (entry.type === "user") {
      const content = entry.message && entry.message.content;
      if (!firstUser && !entry.isMeta) firstUser = userText(content);
      const own = entry.isMeta ? "other" : "you";
      if (!Array.isArray(content)) enter(own, contentChars(content));
      else for (const b of content) {
        if (b && b.type === "tool_result") { enter(toolNames[b.tool_use_id] || "other", contentChars(b.content)); delete toolNames[b.tool_use_id]; }
        else enter(own, contentChars([b]));
      }
      continue;
    }
    if (entry.type !== "assistant") continue;
    const blocks = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const b of blocks) if (b && b.type === "tool_use" && b.id) toolNames[b.id] = typeof b.name === "string" ? b.name : "other";
    const u = entry.message && entry.message.usage;
    // not an API call: Claude Code writes "<synthetic>" entries with zero usage on API errors and
    // aborts, and a usage without the three input counters says nothing about the context
    if (!u || entry.message.model === "<synthetic>" || !hasInputCounters(u)) continue;
    const before = tokens;
    tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    cacheRead = num(u.cache_read_input_tokens);
    cacheCreated = num(u.cache_creation_input_tokens);
    cacheTtlMs = cacheTtl(u.cache_creation) ?? cacheTtlMs;
    model = (entry.message && entry.message.model) || null;
    lastTurn = entry.timestamp || null;
    effort = typeof entry.effort === "string" ? entry.effort : null;
    const output = num(u.output_tokens);
    const thinking = num(u.output_tokens_details && u.output_tokens_details.thinking_tokens);
    const id = entry.message.id || entry.uuid || null;
    if (id !== lastId) {
      turns += 1; lastId = id;
      series.push(tokens);
      outputSeries.push(output); thinkingSeries.push(thinking);
      outputTotal += output; thinkingTotal += thinking;
      let cause = turns === 1 ? "start" : null;
      if (pendingCompaction) { compactions.push({ at: series.length - 1, ...pendingCompaction }); pendingCompaction = null; cause = "compaction"; }
      if (cause) { baseline = tokens; baselineAt = series.length - 1; baselineCause = cause; baselineId = id; growthBySource = {}; }
      else if (before !== null) attribute(growthBySource, tokens - before, turnOutput, pendingInput);
      pendingInput = {};
    } else {
      if (series.length) series[series.length - 1] = tokens; // another content block of the same turn
      else series.push(tokens); // the same turn continued from a state without a series: a point, not a new turn
      if (id !== null && id === baselineId) baseline = tokens;
      // every block of a response carries the response's output counters, so the turn counts them once
      outputTotal += output - turnOutput; thinkingTotal += thinking - turnThinking;
      if (outputSeries.length) { outputSeries[outputSeries.length - 1] = output; thinkingSeries[thinkingSeries.length - 1] = thinking; }
      else { outputSeries.push(output); thinkingSeries.push(thinking); }
    }
    turnOutput = output; turnThinking = thinking;
  }
  const out = { tokens, model, lastTurn, title: title || firstUser || firstCommand || null, turns, series, cacheTtlMs, cacheRead, cacheCreated, compactions,
    outputSeries, thinkingSeries, outputTotal, thinkingTotal, effort, baseline, baselineAt, baselineCause, growthBySource };
  // hidden state for the continuation: not part of what the panel shows, and not part of toEqual
  Object.defineProperty(out, "lastId", { value: lastId, enumerable: false });
  Object.defineProperty(out, "turnOutput", { value: turnOutput, enumerable: false });
  Object.defineProperty(out, "turnThinking", { value: turnThinking, enumerable: false });
  Object.defineProperty(out, "aiTitle", { value: title, enumerable: false });
  Object.defineProperty(out, "firstUser", { value: firstUser, enumerable: false });
  Object.defineProperty(out, "firstCommand", { value: firstCommand, enumerable: false });
  Object.defineProperty(out, "pendingCompaction", { value: pendingCompaction, enumerable: false });
  Object.defineProperty(out, "baselineId", { value: baselineId, enumerable: false });
  Object.defineProperty(out, "pendingInput", { value: pendingInput, enumerable: false });
  Object.defineProperty(out, "toolNames", { value: toolNames, enumerable: false });
  return out;
}

/**
 * Adds one turn's growth to `into`: first "output", up to what the previous turn wrote, then the rest split
 * over `inputs` (source → characters) in proportion, rounded to whole tokens; "other" when no input was seen.
 */
function attribute(into, growth, output, inputs) {
  if (!(growth > 0)) return;
  const add = (source, n) => { if (n > 0) into[source] = (into[source] || 0) + n; };
  const own = Math.min(num(output), growth);
  add("output", own);
  const rest = growth - own, total = Object.values(inputs).reduce((a, b) => a + b, 0);
  if (!total) { add("other", rest); return; }
  for (const [source, chars] of Object.entries(inputs)) add(source, Math.round((rest * chars) / total));
}

/** The length of a message content (a string or blocks): text by its characters, an image as IMAGE_CHARS, any other block as its JSON. */
function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    n += b.type === "text" && typeof b.text === "string" ? b.text.length : b.type === "image" ? IMAGE_CHARS : JSON.stringify(b).length;
  }
  return n;
}

/** A compaction from compact_boundary's compactMetadata; a missing field is null. */
function compaction(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  return { trigger: typeof m.trigger === "string" ? m.trigger : null, preTokens: numOrNull(m.preTokens), postTokens: numOrNull(m.postTokens), durationMs: numOrNull(m.durationMs) };
}

/** Indexes in `series` where the count fell below DIP_BELOW of the previous turn (a compaction or a /clear). */
function dips(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) if (series[i] < series[i - 1] * DIP_BELOW) out.push(i);
  return out;
}

/**
 * The per-turn fields of a parsed transcript, kept to the last `max` turns: `series`, and `outputSeries` and
 * `thinkingSeries` aligned to its right end; the compactions and `baselineAt` move with the cut (a compaction
 * whose turn is cut drops out, a cut first turn makes baselineAt null; the baseline itself stays); `dips` of
 * what is kept, without the turns of a compaction (those are marked as such). Without `max`, every turn.
 */
function seriesFor(t, max = Infinity) {
  const all = Array.isArray(t.series) ? t.series : [];
  const cut = Math.max(0, all.length - max);
  const series = all.slice(cut);
  const last = (a) => (Array.isArray(a) ? a.slice(Math.max(0, a.length - max)) : []);
  const compactions = (Array.isArray(t.compactions) ? t.compactions : []).map((c) => ({ ...c, at: c.at - cut })).filter((c) => c.at >= 0);
  const compactedAt = new Set(compactions.map((c) => c.at));
  const baselineAt = Number.isFinite(t.baselineAt) && t.baselineAt >= cut ? t.baselineAt - cut : null;
  return { series, outputSeries: last(t.outputSeries), thinkingSeries: last(t.thinkingSeries), compactions,
    dips: dips(series).filter((i) => !compactedAt.has(i)), baselineAt };
}

/** The panel's number format ("850", "43K", "1.2M", "unknown"), for the facts below; panel.html has the same rule, since the webview cannot require this file, and test/panel.test.js keeps the two equal. */
function tokensText(tokens) {
  if (!Number.isFinite(tokens)) return "unknown";
  if (tokens < 1000) return String(tokens);
  if (Math.round(tokens / 1000) < 1000) return `${Math.round(tokens / 1000)}K`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

// What to do at the next phase boundary, per zone (Matt Pocock's PHASE-BOUNDARIES.md, not in this repo): the detail view shows it under the
// count, the list's bar and the header's zone band in their tooltips. Green has none: a session there is in the smart zone.
// Orange starts where the smart zone is spent, so only his first question is left: does the next phase need this one
// as a primary source.
const ZONE_ADVICE = Object.freeze({
  orange: "Break at the next phase boundary; continue only if the next phase needs this one verbatim.",
  red: "Do not start a new phase: /clear, /handoff, a subagent, or /compact.",
});

// The zones as the panel draws them, sent with every list so the panel keeps no copy of the limits: in order, each
// with its bounds (`to` is null for red, which has none), its range as text, long and short (for a narrow band in the
// header), and its advice. Orange includes RED_ABOVE itself (zone()); the texts leave that out.
const ZONE_LIST = Object.freeze([
  ["green", 0, ORANGE_FROM, `below ${tokensText(ORANGE_FROM)}`, `<${tokensText(ORANGE_FROM)}`],
  ["orange", ORANGE_FROM, RED_ABOVE, `${tokensText(ORANGE_FROM)}–${tokensText(RED_ABOVE)}`, `${tokensText(ORANGE_FROM)}+`],
  ["red", RED_ABOVE, null, `above ${tokensText(RED_ABOVE)}`, `>${tokensText(RED_ABOVE)}`],
].map(([name, from, to, range, short]) => Object.freeze({ zone: name, from, to, range, short, advice: ZONE_ADVICE[name] || null })));

/**
 * What the detail view says under its header, which carries the count and the zone: `advice`, the zone's advice
 * (null for green or an unknown zone); `facts`, named [label, value] pairs: where the current segment started
 * ("This segment started at" after a compaction, "Session started at" from the start) and "Compactions" when the
 * session had any; and `typicalStart`, what a fresh session in the list typically starts at ("~29K" from
 * `median`, the list's baselineMedian; null without one). Facts only: no line on what a break would give back.
 */
function contextFacts({ zone: z, compactionCount, baseline, baselineCause }, median) {
  const facts = [];
  if (Number.isFinite(baseline)) facts.push([baselineCause === "compaction" ? "This segment started at" : "Session started at", tokensText(baseline)]);
  if (compactionCount > 0) facts.push(["Compactions", String(compactionCount)]);
  return { advice: ZONE_ADVICE[z] || null, facts, typicalStart: Number.isFinite(median) ? `~${tokensText(median)}` : null };
}

/**
 * growthBySource as the rows of a chart: { source, tokens, share } for every source above zero, largest first
 * (equal counts by name), `share` of their sum. An estimate (see parseTranscript); the caveat belongs once
 * under the chart, so a row carries none.
 */
function growthRows(growthBySource) {
  const g = growthBySource && typeof growthBySource === "object" ? growthBySource : {};
  const list = Object.entries(g).filter(([, n]) => Number.isFinite(n) && n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sum = list.reduce((a, [, n]) => a + n, 0);
  return list.map(([source, tokens]) => ({ source, tokens, share: tokens / sum }));
}

function parseEntry(line) {
  if (!line || line[0] !== "{") return null;
  try { return JSON.parse(line); } catch { return null; }
}

function num(v) { return Number.isFinite(v) ? v : 0; }
function numOrNull(v) { return Number.isFinite(v) ? v : null; }

/**
 * The TTL a turn wrote cache under, from usage.cache_creation: 5 minutes when ephemeral_5m_input_tokens is
 * above zero (also when the 1-hour counter is: that part goes cold first), 1 hour when only
 * ephemeral_1h_input_tokens is; null when the turn created nothing or the object is missing (older Claude Code).
 */
function cacheTtl(creation) {
  if (!creation || typeof creation !== "object") return null;
  if (num(creation.ephemeral_5m_input_tokens) > 0) return TTL_5M_MS;
  if (num(creation.ephemeral_1h_input_tokens) > 0) return TTL_1H_MS;
  return null;
}

function hasInputCounters(u) {
  return [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].some(Number.isFinite);
}

/** A user message as one line; a slash command becomes "/name args". Null when there is no text. */
function userText(content) {
  const parts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text) : [];
  const text = parts.join(" ").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
    return [command[1].trim(), args ? args[1].trim() : ""].filter(Boolean).join(" ");
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine ? oneLine.slice(0, 120) : null;
}

/**
 * The list the panel shows: the registry joined with the parsed transcripts (`transcripts`, keyed by
 * sessionId). The default scope is the sessions inside the window's workspace folders; with `all`
 * the whole machine is included, grouped by project. Sorted busy first, then waiting, then last turn newest
 * first, unknown last. `waiting` is a session that waits for the user: a permission prompt, a question or a
 * dialog (the registry's status "waiting", NOTES.md "Session status"); any other status but "busy" counts as
 * idle. `zoneCounts` counts the listed sessions per zone; sessions with an unknown count are not counted. Per session the prompt cache: `hitShare` (cacheRead / tokens of the last turn), `coldAt` (the last
 * turn plus the TTL), `coldInMs` (until then, negative when past) and `cacheState` ("warm" or "cold", null
 * without a TTL); `cacheCounts` counts the listed sessions per state. `baselineMedian` is the median baseline
 * of the listed sessions whose segment is a start (after a compaction the baseline holds the summary too), null
 * when there are none, so a CLAUDE.md that grew shows as a higher start for every new session. The per-turn
 * fields are kept to the last SERIES_MAX turns (seriesFor; SessionReader.detail gives all of them);
 * `compactionCount` counts the whole session's. `growth` is growthBySource as rows (growthRows); `advice`, `facts`
 * and `typicalStart` are what the detail view says under its header (contextFacts, with the list's baselineMedian).
 * `abandoned` is a session that is neither busy nor waiting and whose last turn and process start are both more than
 * DIM_AFTER_MS ago (an empty session by its start alone);
 * `abandonedCount` counts them. `hiddenCount` is how many live sessions the scope leaves out (0 with `all` or without
 * workspace folders), counted from the registry alone, and `workspaceNames` the last folder name of each workspace
 * folder, so the panel can name the scope ("This workspace · my-project · 4 more in other projects"). `zones` is
 * ZONE_LIST, the zones with their limits, range texts and advice, for everything the panel draws them on.
 */
function buildSessions({ registry = [], transcripts = {}, now, workspaceFolders = [], all = false }) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const sessions = registry
    .filter((r) => all || workspaceFolders.length === 0 || workspaceFolders.some((f) => inFolder(r.cwd, f)))
    .map((r) => {
      const t = transcripts[r.sessionId] || {};
      const tokens = numOrNull(t.tokens);
      const { series, outputSeries, thinkingSeries, compactions, dips: drops, baselineAt } = seriesFor(t, SERIES_MAX);
      const lastMs = t.lastTurn ? Date.parse(t.lastTurn) : NaN;
      const sinceMs = Number.isFinite(lastMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - lastMs) : null;
      const cacheTtlMs = numOrNull(t.cacheTtlMs);
      const cacheRead = numOrNull(t.cacheRead);
      const coldMs = cacheTtlMs !== null && Number.isFinite(lastMs) ? lastMs + cacheTtlMs : NaN;
      const coldInMs = Number.isFinite(coldMs) && Number.isFinite(nowMs) ? coldMs - nowMs : null;
      const startedMs = Number(r.startedAt) || NaN;
      const busy = r.status === "busy", waiting = r.status === "waiting", dimmed = sinceMs !== null && sinceMs > DIM_AFTER_MS;
      const activeMs = Math.max(Number.isFinite(lastMs) ? lastMs : -Infinity, Number.isFinite(startedMs) ? startedMs : -Infinity);
      const quiet = Number.isFinite(activeMs) && Number.isFinite(nowMs) && nowMs - activeMs > DIM_AFTER_MS;
      return {
        pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, project: projectName(r.cwd), name: r.name || null,
        startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null, // the registry's epoch ms, as ISO like lastTurn
        title: t.title || null, model: t.model || null, modelShort: modelShort(t.model),
        tokens, zone: zone(tokens), turns: t.turns || 0, series, compactions, dips: drops,
        compactionCount: Array.isArray(t.compactions) ? t.compactions.length : 0, // the whole session's, also those cut from the series
        lastTurn: t.lastTurn || null, sinceMs, outputSeries, thinkingSeries,
        outputTotal: numOrNull(t.outputTotal), thinkingTotal: numOrNull(t.thinkingTotal),
        effort: typeof t.effort === "string" ? t.effort : null,
        baseline: numOrNull(t.baseline), baselineAt,
        baselineCause: t.baselineCause === "start" || t.baselineCause === "compaction" ? t.baselineCause : null,
        growth: growthRows(t.growthBySource),
        cacheTtlMs, cacheRead, cacheCreated: numOrNull(t.cacheCreated),
        hitShare: cacheRead !== null && tokens ? cacheRead / tokens : null,
        coldAt: Number.isFinite(coldMs) ? new Date(coldMs).toISOString() : null, coldInMs,
        cacheState: coldInMs === null ? null : coldInMs > 0 ? "warm" : "cold",
        busy, waiting, dimmed, abandoned: !busy && !waiting && quiet,
        _lastMs: Number.isFinite(lastMs) ? lastMs : -Infinity,
      };
    })
    .sort((a, b) => (b.busy - a.busy) || (b.waiting - a.waiting) || (b._lastMs - a._lastMs) || (a.pid - b.pid));
  sessions.forEach((s) => { delete s._lastMs; });
  let groups = null;
  if (all) {
    const byProject = new Map();
    for (const s of sessions) { if (!byProject.has(s.project)) byProject.set(s.project, []); byProject.get(s.project).push(s); }
    groups = [...byProject].map(([project, list]) => ({ project, sessions: list }));
  }
  const zoneCounts = { green: 0, orange: 0, red: 0 };
  for (const s of sessions) if (s.zone) zoneCounts[s.zone] += 1;
  const cacheCounts = { warm: 0, cold: 0 };
  for (const s of sessions) if (s.cacheState) cacheCounts[s.cacheState] += 1;
  const starts = sessions.filter((s) => s.baselineCause === "start" && s.baseline !== null).map((s) => s.baseline).sort((a, b) => a - b);
  const mid = starts.length >> 1;
  const baselineMedian = !starts.length ? null : starts.length % 2 ? starts[mid] : (starts[mid - 1] + starts[mid]) / 2;
  for (const s of sessions) Object.assign(s, contextFacts(s, baselineMedian));
  return { sessions, groups, count: sessions.length, zoneCounts, cacheCounts, baselineMedian, baselineSessions: starts.length,
    abandonedCount: sessions.filter((s) => s.abandoned).length, hiddenCount: registry.length - sessions.length,
    workspaceNames: workspaceFolders.map(projectName).filter(Boolean), zones: ZONE_LIST };
}

/**
 * True when `cwd` is `folder` or below it. Both are compared with `/` as the separator and without a
 * trailing one; on Windows also case-insensitively (VS Code gives `c:\…` where the registry can have `C:\…`).
 */
function inFolder(cwd, folder, platform = process.platform) {
  const c = comparablePath(cwd, platform), f = comparablePath(folder, platform);
  return c === f || c.startsWith(`${f}/`);
}

function comparablePath(p, platform) {
  const s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? s.toLowerCase() : s;
}

function projectName(cwd) {
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** "claude-opus-5-5" → "Opus 5.5"; a name outside the pattern is shown as is. */
function modelShort(model) {
  if (!model) return null;
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : model;
}

/**
 * The folder Claude Code stores its data in, for both hosts: `given` (the VS Code setting or the --claude-dir flag),
 * else CLAUDE_CONFIG_DIR, else ~/.claude. A relative one is resolved against `cwd`, so both hosts read the same one.
 */
function claudeDir(given, env = process.env, cwd = process.cwd()) {
  const dir = String(given || "").trim() || env.CLAUDE_CONFIG_DIR;
  return dir ? path.resolve(cwd, dir) : path.join(os.homedir(), ".claude");
}

/**
 * The panel's CSP, one copy for both hosts and the demo: only the nonce'd inline style and script run; `connect`
 * lets the browser page reach its own origin (fetch, EventSource), which the webview never needs.
 */
function pageCsp(nonce, connect = false) {
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';${connect ? " connect-src 'self';" : ""}`;
}

/** A CSP nonce: unguessable, so only the panel's own inline style and script run. */
function randomNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Reads the registry and the transcripts incrementally: each transcript keeps its parsed state and byte
 * offset, so a refresh reads only the new bytes; `read({ full: true })` forgets that state first and reads
 * every transcript from its first byte (the panel's refresh button). It lives here and not in extension.js
 * (that file requires "vscode") so the tests can run it.
 * `alive` is injectable for tests; the default asks the OS whether the pid exists.
 */
class SessionReader {
  constructor(claudeDir, { alive } = {}) {
    this.sessionsDir = path.join(claudeDir, "sessions");
    this.projectsDir = path.join(claudeDir, "projects");
    this.alive = alive || isAlive;
    this.cache = new Map(); // transcript file → { end, state }
    this.found = new Map(); // sessionId → project folder found by searching, when the slug folder is missing
    this.files = new Map(); // sessionId → transcript file of the last read, for detail()
  }

  read({ workspaceFolders, all, full = false }) {
    if (full) { this.cache.clear(); this.found.clear(); }
    const errors = [];
    const registry = readRegistry(this.sessionsDir, this.alive);
    if (registry.error) errors.push(registry.error);
    // only the sessions in scope are read: outside the window they would be filtered away anyway,
    // and their missing project folders are not this window's errors
    const inScope = buildSessions({ registry: registry.sessions, now: Date.now(), workspaceFolders, all }).sessions;
    const transcripts = {};
    const projectFolders = new Set();
    const live = new Set();
    const liveIds = new Set();
    this.files = new Map();
    for (const s of inScope) {
      if (!s.cwd || !s.sessionId) continue;
      liveIds.add(s.sessionId);
      const slugFolder = path.join(this.projectsDir, projectSlug(s.cwd));
      const folder = this.projectFolder(slugFolder, s.sessionId);
      projectFolders.add(folder || slugFolder);
      if (!folder) { errors.push(`Project folder not found: ${slugFolder}`); continue; }
      const file = path.join(folder, `${s.sessionId}.jsonl`);
      live.add(file);
      this.files.set(s.sessionId, file);
      try { transcripts[s.sessionId] = this.readTranscript(file); }
      catch (e) { this.cache.delete(file); errors.push(`Transcript not read: ${file} (${e.code || e.message})`); }
    }
    for (const file of this.cache.keys()) if (!live.has(file)) this.cache.delete(file);
    for (const id of this.found.keys()) if (!liveIds.has(id)) this.found.delete(id);
    const list = buildSessions({ registry: registry.sessions, transcripts, now: Date.now(), workspaceFolders, all });
    return { ...list, all, errors: [...new Set(errors)], generatedAt: new Date().toISOString(), projectFolders: [...projectFolders] };
  }

  /**
   * Every turn of one session, for the detail view: `turns`, and `series`, `outputSeries`, `thinkingSeries`,
   * `compactions`, `dips` and `baselineAt` as in the list but not cut to SERIES_MAX. Taken from the state the
   * last read parsed, without reading again, so it is the same transcript as the list the panel shows; null
   * for a session that read did not parse (outside the scope, gone, or its transcript missing).
   */
  detail(sessionId) {
    const file = this.files.get(sessionId);
    const cached = file ? this.cache.get(file) : null;
    if (!cached || !cached.state) return null;
    return { turns: cached.state.turns || 0, ...seriesFor(cached.state) };
  }

  /**
   * The slug folder when it exists; otherwise the folder in projects/ that holds `<sessionId>.jsonl`
   * (names over 200 characters, CLAUDE_CODE_PROJECT_DIR_NAME, a rule that differs), remembered per
   * sessionId. Null when neither is found.
   */
  projectFolder(slugFolder, sessionId) {
    if (fs.existsSync(slugFolder)) return slugFolder;
    const known = this.found.get(sessionId);
    if (known && fs.existsSync(path.join(known, `${sessionId}.jsonl`))) return known;
    let names;
    try { names = fs.readdirSync(this.projectsDir); } catch { return null; }
    for (const name of names) {
      const folder = path.join(this.projectsDir, name);
      if (fs.existsSync(path.join(folder, `${sessionId}.jsonl`))) { this.found.set(sessionId, folder); return folder; }
    }
    return null;
  }

  readTranscript(file) {
    const cached = this.cache.get(file);
    const tail = readTail(file, { from: cached ? cached.end : 0 });
    if (tail.missing) { this.cache.delete(file); return null; }
    const state = parseTranscript(tail.lines, cached && !tail.restarted ? cached.state : null);
    this.cache.set(file, { end: tail.end, state });
    return state;
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * Watches Claude Code's folders and calls `onChange` after each change, debounced, and on a tick (which
 * refreshes "x min ago" and catches processes that died without removing their registry file). start()
 * watches sessions/ and projects/ (a new project folder appears there); the project folders a read
 * returns are added with watchAll(). Here and not in extension.js so the tests can run it.
 */
class SessionWatcher {
  constructor(claudeDir, onChange, { debounceMs = 250, tickMs = 30000 } = {}) {
    this.claudeDir = claudeDir;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.tickMs = tickMs;
    this.watchers = new Map(); // folder → fs.FSWatcher
    this.timer = null;
    this.tick = null;
  }

  start() {
    this.watch(path.join(this.claudeDir, "sessions"));
    this.watch(path.join(this.claudeDir, "projects"));
    clearInterval(this.tick);
    this.tick = setInterval(() => this.onChange(), this.tickMs);
  }

  /** Watches every folder listed and stops watching the project folders a read no longer lists (they left the scope). */
  watchAll(folders) {
    const keep = new Set([path.join(this.claudeDir, "sessions"), path.join(this.claudeDir, "projects"), ...folders]);
    for (const [folder, w] of this.watchers) if (!keep.has(folder)) { w.close(); this.watchers.delete(folder); }
    for (const f of folders) this.watch(f);
  }

  watch(folder) {
    if (this.watchers.has(folder) || !fs.existsSync(folder)) return;
    try {
      const w = fs.watch(folder, () => this.schedule());
      w.on("error", () => { w.close(); this.watchers.delete(folder); });
      this.watchers.set(folder, w);
    } catch { /* the folder vanished between the check and the watch; the next read retries */ }
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(), this.debounceMs);
  }

  stop() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.timer = this.tick = null;
  }
}

module.exports = { projectSlug, zone, tokensText, dips, readRegistry, readTail, parseTranscript, seriesFor, contextFacts, growthRows, buildSessions, inFolder, projectName, modelShort, claudeDir, pageCsp, randomNonce, SessionReader, SessionWatcher };
