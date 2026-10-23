// core.cjs — pure functions behind the "Claude Context" panel. No VS Code dependency: the extension
// host (extension.js), the tests (test/core.test.js) and any other host that embeds panel.html (for
// example a dev server serving it in a browser) all require this file. The transcript format is
// Claude Code's internal one and may change between versions, so a missing field yields null
// ("unknown"), never an error.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Quality warnings, not the window limit: absolute token counts calibrated on Matt Pocock's smart/dumb zone
// (the dumb zone "commonly begins around 125K-150K tokens"); the orange band is that range.
const YELLOW_FROM = 100000, ORANGE_FROM = 125000, RED_ABOVE = 150000;
const DIM_AFTER_MS = 60 * 60 * 1000;
// The prompt cache's two TTLs. Every turn re-sends the whole context; while the cache is warm the context is
// read from it, and the cache is refreshed on every use, so the deadline is the last turn plus the TTL.
// Prices (platform.claude.com/docs/en/docs/build-with-claude/prompt-caching, read 2026-10-22): a 5-minute
// write costs 1.25× input, a 1-hour write 2×, a read 0.1× (0.025× on Fable and Mythos 5.1, 0.05× on Opus and
// Sonnet 5.5). A session that went cold rewrites its whole context on the next turn.
const TTL_1H_MS = 60 * 60 * 1000, TTL_5M_MS = 5 * 60 * 1000;
const SERIES_MAX = 200; // the sparkline keeps the last 200 turns, so the payload to the webview stays small
const DIP_BELOW = 0.7; // a turn is a dip when its context is below 70 % of the previous turn's

/** The folder name Claude Code gives a project under projects/: every non-alphanumeric char becomes "-". */
function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Zone for a token count: green below 100K, yellow below 125K, orange up to and including 150K, red above, null when unknown. */
function zone(tokens) {
  if (!Number.isFinite(tokens)) return null;
  return tokens < YELLOW_FROM ? "green" : tokens < ORANGE_FROM ? "yellow" : tokens <= RED_ABOVE ? "orange" : "red";
}

/**
 * The registry of Claude sessions: one JSON file per process in Claude Code's sessions/ folder. Only
 * entries where alive(pid) is true are kept (a file can linger after a process died abruptly).
 */
function readRegistry(dir, alive) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { sessions: [], error: `Registry folder not found: ${dir}` }; }
  const sessions = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let entry;
    try { entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
    const pid = Number(entry && entry.pid);
    if (!Number.isFinite(pid) || !alive(pid)) continue;
    sessions.push({
      pid, sessionId: entry.sessionId || null, cwd: entry.cwd || null, status: entry.status || null,
      statusUpdatedAt: entry.statusUpdatedAt || null, startedAt: entry.startedAt || null,
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
 * message.id, so turns are counted per id. `series` is the token count per turn, oldest first, kept to the
 * last SERIES_MAX turns. `compactions` are the compact_boundary entries Claude Code writes, each at `at`, the
 * index in `series` of the first turn after it, with the trigger ("auto", "manual") and the counts before and
 * after; a /clear starts a new transcript, so it never shows here. `outputSeries` and `thinkingSeries` are the
 * output tokens per turn and the thinking part of them (usage.output_tokens, output_tokens_details.thinking_tokens),
 * aligned with `series` and counted once per turn (every block of a response carries the same counters);
 * `outputTotal` and `thinkingTotal` sum them over the whole transcript, and `effort` is the last turn's.
 * `baseline` is the token count of the first turn of the current segment: the fixed load (CLAUDE.md, memory,
 * skill and tool listings) plus the first message. A segment starts with the transcript (a new session or a
 * /clear) or at a compaction, which `baselineCause` says ("start", "compaction"); later blocks of that turn
 * update it like the series. `baselineAt` is the segment's first index in `series`, null once it is trimmed
 * out (the baseline stays). A state parsed by an older core gets no baseline: its first turn is unknown. The title is the last ai-title entry, else
 * the first user message (meta entries and tool results skipped) collapsed to one line. With `previous`, the
 * lines are parsed as the continuation of an already parsed transcript, so the host reads only the new bytes.
 */
function parseTranscript(lines, previous) {
  const p = previous || {};
  let tokens = p.tokens ?? null, model = p.model ?? null, lastTurn = p.lastTurn ?? null;
  let cacheTtlMs = p.cacheTtlMs ?? null, cacheRead = p.cacheRead ?? null, cacheCreated = p.cacheCreated ?? null;
  let title = p.title || null, firstUser = p.firstUser || null;
  let turns = p.turns || 0, lastId = p.lastId || null;
  let pendingCompaction = p.pendingCompaction || null;
  let outputTotal = p.outputTotal || 0, thinkingTotal = p.thinkingTotal || 0, effort = p.effort ?? null;
  let turnOutput = p.turnOutput || 0, turnThinking = p.turnThinking || 0;
  let baseline = p.baseline ?? null, baselineAt = p.baselineAt ?? null, baselineCause = p.baselineCause ?? null, baselineId = p.baselineId ?? null;
  const series = Array.isArray(p.series) ? p.series.slice() : [];
  const outputSeries = Array.isArray(p.outputSeries) ? p.outputSeries.slice() : [];
  const thinkingSeries = Array.isArray(p.thinkingSeries) ? p.thinkingSeries.slice() : [];
  let compactions = Array.isArray(p.compactions) ? p.compactions.map((c) => ({ ...c })) : [];
  for (const line of lines) {
    const entry = parseEntry(line);
    if (!entry || entry.isSidechain) continue;
    if (entry.type === "system" && entry.subtype === "compact_boundary") { pendingCompaction = compaction(entry.compactMetadata); continue; }
    if (entry.type === "ai-title") { if (entry.aiTitle) title = String(entry.aiTitle); continue; }
    if (entry.type === "user") { if (!firstUser && !entry.isMeta) firstUser = userText(entry.message && entry.message.content); continue; }
    if (entry.type !== "assistant") continue;
    const u = entry.message && entry.message.usage;
    // not an API call: Claude Code writes "<synthetic>" entries with zero usage on API errors and
    // aborts, and a usage without the three input counters says nothing about the context
    if (!u || entry.message.model === "<synthetic>" || !hasInputCounters(u)) continue;
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
      if (cause) { baseline = tokens; baselineAt = series.length - 1; baselineCause = cause; baselineId = id; }
      if (series.length > SERIES_MAX) {
        series.shift();
        compactions = compactions.map((c) => ({ ...c, at: c.at - 1 })).filter((c) => c.at >= 0);
        if (baselineAt !== null) baselineAt = baselineAt > 0 ? baselineAt - 1 : null;
      }
      if (outputSeries.length > SERIES_MAX) { outputSeries.shift(); thinkingSeries.shift(); }
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
  const out = { tokens, model, lastTurn, title: title || firstUser || null, turns, series, cacheTtlMs, cacheRead, cacheCreated, compactions,
    outputSeries, thinkingSeries, outputTotal, thinkingTotal, effort, baseline, baselineAt, baselineCause };
  // hidden state for the continuation: not part of what the panel shows, and not part of toEqual
  Object.defineProperty(out, "lastId", { value: lastId, enumerable: false });
  Object.defineProperty(out, "turnOutput", { value: turnOutput, enumerable: false });
  Object.defineProperty(out, "turnThinking", { value: turnThinking, enumerable: false });
  Object.defineProperty(out, "firstUser", { value: firstUser, enumerable: false });
  Object.defineProperty(out, "pendingCompaction", { value: pendingCompaction, enumerable: false });
  Object.defineProperty(out, "baselineId", { value: baselineId, enumerable: false });
  return out;
}

/** A compaction from compact_boundary's compactMetadata; a missing field is null. */
function compaction(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  const n = (v) => (Number.isFinite(v) ? v : null);
  return { trigger: typeof m.trigger === "string" ? m.trigger : null, preTokens: n(m.preTokens), postTokens: n(m.postTokens), durationMs: n(m.durationMs) };
}

/** Indexes in `series` where the count fell below DIP_BELOW of the previous turn (a compaction or a /clear). */
function dips(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) if (series[i] < series[i - 1] * DIP_BELOW) out.push(i);
  return out;
}

function parseEntry(line) {
  if (!line || line[0] !== "{") return null;
  try { return JSON.parse(line); } catch { return null; }
}

function num(v) { return Number.isFinite(v) ? v : 0; }

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
 * the whole machine is included, grouped by project. Sorted busy first, then last turn newest first,
 * unknown last. `zoneCounts` counts the listed sessions per zone; sessions with an unknown count are not
 * counted. Per session the prompt cache: `hitShare` (cacheRead / tokens of the last turn), `coldAt` (the last
 * turn plus the TTL), `coldInMs` (until then, negative when past) and `cacheState` ("warm" or "cold", null
 * without a TTL); `cacheCounts` counts the listed sessions per state. `baselineMedian` is the median baseline
 * of the listed sessions whose segment is a start (after a compaction the baseline holds the summary too), null
 * when there are none, so a CLAUDE.md that grew shows as a higher start for every new session.
 */
function buildSessions({ registry = [], transcripts = {}, now, workspaceFolders = [], all = false }) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const sessions = registry
    .filter((r) => all || workspaceFolders.length === 0 || workspaceFolders.some((f) => inFolder(r.cwd, f)))
    .map((r) => {
      const t = transcripts[r.sessionId] || {};
      const tokens = Number.isFinite(t.tokens) ? t.tokens : null;
      const series = Array.isArray(t.series) ? t.series : [];
      const compactions = Array.isArray(t.compactions) ? t.compactions : [];
      const compactedAt = new Set(compactions.map((c) => c.at));
      const lastMs = t.lastTurn ? Date.parse(t.lastTurn) : NaN;
      const sinceMs = Number.isFinite(lastMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - lastMs) : null;
      const cacheTtlMs = Number.isFinite(t.cacheTtlMs) ? t.cacheTtlMs : null;
      const cacheRead = Number.isFinite(t.cacheRead) ? t.cacheRead : null;
      const coldMs = cacheTtlMs !== null && Number.isFinite(lastMs) ? lastMs + cacheTtlMs : NaN;
      const coldInMs = Number.isFinite(coldMs) && Number.isFinite(nowMs) ? coldMs - nowMs : null;
      return {
        pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, project: projectName(r.cwd),
        title: t.title || null, model: t.model || null, modelShort: modelShort(t.model),
        tokens, zone: zone(tokens), turns: t.turns || 0, series, compactions,
        dips: dips(series).filter((i) => !compactedAt.has(i)), // a compaction is marked as such, not again as a dip
        lastTurn: t.lastTurn || null, sinceMs,
        outputSeries: Array.isArray(t.outputSeries) ? t.outputSeries : [], thinkingSeries: Array.isArray(t.thinkingSeries) ? t.thinkingSeries : [],
        outputTotal: Number.isFinite(t.outputTotal) ? t.outputTotal : null, thinkingTotal: Number.isFinite(t.thinkingTotal) ? t.thinkingTotal : null,
        effort: typeof t.effort === "string" ? t.effort : null,
        baseline: Number.isFinite(t.baseline) ? t.baseline : null, baselineAt: Number.isFinite(t.baselineAt) ? t.baselineAt : null,
        baselineCause: t.baselineCause === "start" || t.baselineCause === "compaction" ? t.baselineCause : null,
        cacheTtlMs, cacheRead, cacheCreated: Number.isFinite(t.cacheCreated) ? t.cacheCreated : null,
        hitShare: cacheRead !== null && tokens ? cacheRead / tokens : null,
        coldAt: Number.isFinite(coldMs) ? new Date(coldMs).toISOString() : null, coldInMs,
        cacheState: coldInMs === null ? null : coldInMs > 0 ? "warm" : "cold",
        busy: r.status === "busy", dimmed: sinceMs !== null && sinceMs > DIM_AFTER_MS,
        _lastMs: Number.isFinite(lastMs) ? lastMs : -Infinity,
      };
    })
    .sort((a, b) => (b.busy - a.busy) || (b._lastMs - a._lastMs) || (a.pid - b.pid));
  sessions.forEach((s) => { delete s._lastMs; });
  let groups = null;
  if (all) {
    const byProject = new Map();
    for (const s of sessions) { if (!byProject.has(s.project)) byProject.set(s.project, []); byProject.get(s.project).push(s); }
    groups = [...byProject].map(([project, list]) => ({ project, sessions: list }));
  }
  const zoneCounts = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const s of sessions) if (s.zone) zoneCounts[s.zone] += 1;
  const cacheCounts = { warm: 0, cold: 0 };
  for (const s of sessions) if (s.cacheState) cacheCounts[s.cacheState] += 1;
  const starts = sessions.filter((s) => s.baselineCause === "start" && s.baseline !== null).map((s) => s.baseline).sort((a, b) => a - b);
  const mid = starts.length >> 1;
  const baselineMedian = !starts.length ? null : starts.length % 2 ? starts[mid] : (starts[mid - 1] + starts[mid]) / 2;
  return { sessions, groups, count: sessions.length, zoneCounts, cacheCounts, baselineMedian, baselineSessions: starts.length };
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
 * Reads the registry and the transcripts incrementally: each transcript keeps its parsed state and byte
 * offset, so a refresh reads only the new bytes. Shared by the extension host and other hosts of the
 * panel, which is why it lives here and not in extension.js (that file requires "vscode"). `alive` is injectable
 * for tests; the default asks the OS whether the pid exists.
 */
class SessionReader {
  constructor(claudeDir, { alive } = {}) {
    this.sessionsDir = path.join(claudeDir, "sessions");
    this.projectsDir = path.join(claudeDir, "projects");
    this.alive = alive || isAlive;
    this.cache = new Map(); // transcript file → { end, state }
    this.found = new Map(); // sessionId → project folder found by searching, when the slug folder is missing
  }

  read({ workspaceFolders, all }) {
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
    for (const s of inScope) {
      if (!s.cwd || !s.sessionId) continue;
      liveIds.add(s.sessionId);
      const slugFolder = path.join(this.projectsDir, projectSlug(s.cwd));
      const folder = this.projectFolder(slugFolder, s.sessionId);
      projectFolders.add(folder || slugFolder);
      if (!folder) { errors.push(`Project folder not found: ${slugFolder}`); continue; }
      const file = path.join(folder, `${s.sessionId}.jsonl`);
      live.add(file);
      transcripts[s.sessionId] = this.readTranscript(file);
    }
    for (const file of this.cache.keys()) if (!live.has(file)) this.cache.delete(file);
    for (const id of this.found.keys()) if (!liveIds.has(id)) this.found.delete(id);
    const list = buildSessions({ registry: registry.sessions, transcripts, now: Date.now(), workspaceFolders, all });
    return { ...list, all, errors: [...new Set(errors)], generatedAt: new Date().toISOString(), projectFolders: [...projectFolders] };
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
 * returns are added with watchAll(). Shared by the extension host and other hosts of the panel.
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

  watchAll(folders) {
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

module.exports = { projectSlug, zone, dips, readRegistry, readTail, parseTranscript, buildSessions, inFolder, projectName, SessionReader, SessionWatcher, isAlive };
