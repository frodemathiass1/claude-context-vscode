// survey.cjs — what Claude Code writes on this machine today, against what core.cjs reads. Prints field names,
// the values of enumerations (status, type, model, trigger) and counts only: never a cwd, title, message or
// other content, so the output can go into NOTES.md as it is.
// Usage: node .claude/skills/facts/scripts/survey.cjs [claudeDir] [--days 7] [--max 40]
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require(path.resolve(__dirname, "../../../../core.cjs"));

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const DAYS = opt("--days", 7), MAX = opt("--max", 40);
const dir = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")))
  || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

const count = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const keysOf = (map, obj) => { if (obj && typeof obj === "object") for (const k of Object.keys(obj)) count(map, k); };
const show = (title, map, of) => {
  console.log(`  ${title}:`);
  if (!map.size) { console.log("    (none)"); return; }
  for (const [k, n] of [...map].sort((a, b) => b[1] - a[1])) console.log(`    ${k}  ${n}${of ? `/${of}` : ""}`);
};
const missing = (title, total, checks) => {
  console.log(`  ${title} (missing / ${total}):`);
  for (const [name, n] of Object.entries(checks)) console.log(`    ${name}  ${n}${n ? "  <-- check" : ""}`);
};

console.log(`Claude dir: ${dir === path.join(os.homedir(), ".claude") ? "~/.claude" : "(custom)"}`);

// Registry: sessions/<pid>.json, as readRegistry reads it
const sessionsDir = path.join(dir, "sessions");
let names = [];
try { names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".json")); } catch { console.log("\nREGISTRY: folder not found"); }
if (names.length) {
  const fields = new Map(), status = new Map(), versions = new Map();
  const reads = { pid: 0, sessionId: 0, cwd: 0, status: 0, startedAt: 0, name: 0 };
  let unreadable = 0, total = 0;
  for (const n of names) {
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(sessionsDir, n), "utf8")); } catch { unreadable++; continue; }
    total++;
    keysOf(fields, e);
    count(status, String(e.status));
    if (e.version) count(versions, String(e.version));
    for (const k of Object.keys(reads)) if (e[k] === undefined || e[k] === null || e[k] === "") reads[k]++;
  }
  console.log(`\nREGISTRY: ${total} entries${unreadable ? `, ${unreadable} unreadable` : ""}`);
  show("Claude Code versions", versions);
  show("status values", status);
  show("fields", fields, total);
  missing("fields core.cjs reads", total, reads);
}

// Transcripts: the most recent projects/*/*.jsonl, as parseTranscript reads them
const projectsDir = path.join(dir, "projects");
const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;
let files = [];
try {
  for (const p of fs.readdirSync(projectsDir)) {
    let entries;
    try { entries = fs.readdirSync(path.join(projectsDir, p)); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(projectsDir, p, f), mtime = fs.statSync(file).mtimeMs;
      if (mtime >= since) files.push({ file, project: p, mtime });
    }
  }
} catch { console.log("\nTRANSCRIPTS: projects folder not found"); }
files = files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX);

if (files.length) {
  const types = new Map(), models = new Map(), usage = new Map(), creation = new Map(), details = new Map();
  const compactMeta = new Map(), triggers = new Map(), versions = new Map();
  const assistantReads = { "message.id": 0, "message.model": 0, "message.usage": 0, timestamp: 0, effort: 0, isSidechain: 0 };
  let assistants = 0, noCounters = 0, attachments = 0, rendered = 0, malformed = 0;
  const parsed = { withTurns: 0, tokens: 0, model: 0, lastTurn: 0, title: 0, cacheTtlMs: 0 };
  const rawModels = new Map();
  for (const { file } of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { malformed++; continue; }
      count(types, e.subtype ? `${e.type}:${e.subtype}` : String(e.type));
      if (e.version) count(versions, String(e.version));
      if (e.type === "system" && e.subtype === "compact_boundary") { keysOf(compactMeta, e.compactMetadata); count(triggers, String(e.compactMetadata && e.compactMetadata.trigger)); }
      if (e.type === "attachment") { attachments++; if (Array.isArray(e.rendered)) rendered++; }
      if (e.type !== "assistant") continue;
      const m = e.message || {};
      count(models, String(m.model));
      if (m.model === "<synthetic>") continue; // an API error or abort, skipped by core
      assistants++;
      if (m.id === undefined) assistantReads["message.id"]++;
      if (m.model === undefined) assistantReads["message.model"]++;
      if (m.usage === undefined) assistantReads["message.usage"]++;
      if (e.timestamp === undefined) assistantReads.timestamp++;
      if (e.effort === undefined) assistantReads.effort++;
      if (e.isSidechain === undefined) assistantReads.isSidechain++;
      keysOf(usage, m.usage);
      keysOf(creation, m.usage && m.usage.cache_creation);
      keysOf(details, m.usage && m.usage.output_tokens_details);
      const u = m.usage;
      if (u && !["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].every((k) => Number.isFinite(u[k]))) noCounters++;
    }
    const t = core.parseTranscript(lines);
    if (!t.turns) continue;
    parsed.withTurns++;
    for (const k of ["tokens", "model", "lastTurn", "title", "cacheTtlMs"]) if (t[k] === null) parsed[k]++;
    if (t.model && core.modelShort(t.model) === t.model) count(rawModels, t.model); // no short name: shown raw
  }
  const projects = new Set(files.map((f) => f.project)).size;
  console.log(`\nTRANSCRIPTS: ${files.length} files from ${projects} projects, modified in the last ${DAYS} days${malformed ? `, ${malformed} malformed lines` : ""}`);
  show("Claude Code versions", versions);
  show("entry types", types);
  show("assistant message.model", models);
  missing("assistant fields core.cjs reads, <synthetic> left out", assistants, assistantReads);
  console.log(`  assistant entries with usage but without the three input counters (skipped by core): ${noCounters}`);
  show("message.usage keys", usage, assistants);
  show("usage.cache_creation keys", creation, assistants);
  show("usage.output_tokens_details keys", details, assistants);
  show("compactMetadata keys", compactMeta);
  show("compaction triggers", triggers);
  console.log(`  attachments: ${attachments}, with rendered[]: ${rendered}`);

  console.log(`\nCORE: parseTranscript on the same files, ${parsed.withTurns} with at least one turn`);
  missing("null in the result", parsed.withTurns, { tokens: parsed.tokens, model: parsed.model, lastTurn: parsed.lastTurn, title: parsed.title, cacheTtlMs: parsed.cacheTtlMs });
  show("models modelShort shows raw (outside claude-<name>-<n>-<m>)", rawModels);
}
