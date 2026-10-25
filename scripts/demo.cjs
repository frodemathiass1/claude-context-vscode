// scripts/demo.cjs — the panel with invented sessions, for the README's screenshots. Real screenshots would show
// the titles of real sessions, which hold the owner's conversations, so this writes invented, deterministic
// transcripts and registry entries to a temporary Claude folder, reads them with the real SessionReader (so the
// payload cannot drift from what the host sends) and wraps panel.html in a page that plays the host, with the browser
// stand-in server.cjs serves the panel with.
//
//   node scripts/demo.cjs          writes demo/light.html and demo/dark.html (open them in a browser)
//   node scripts/demo.cjs --shoot  also takes the screenshots in media/ (dark theme) with a headless Chrome
//
// Run it with --shoot after a change the user can see, so the README's images follow the panel.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const core = require("../src/core.cjs");
const { THEMES, browserPage } = require("../src/server.cjs");

const ROOT = path.join(__dirname, "..");
const MIN = 60 * 1000;
const WORKSPACE = "/Users/me/Dev/tide-tables";

// One invented session per entry. `segments` are the token counts the turns run between, one segment per
// compaction plus one; `out` is the share of the growth that is the model's own output, `tools` how the rest
// is split (a "you" share is the user's messages); `last` and `started` are minutes before now. Together they
// cover every group, every zone, a compaction, a warm, an almost cold and a cold cache, a drop to 5m, and four models.
// `subagents` are the session's, each running from `from` to `to` tokens over its turns: one in red, one running.
const SESSIONS = [
  { title: "Add a harbour picker to the forecast page", cwd: WORKSPACE, status: "busy", model: "claude-opus-5-5", effort: "xhigh",
    segments: [{ turns: 92, from: 29400, to: 247000 }, { turns: 48, from: 44100, to: 168600 }], out: 0.4,
    tools: { Bash: 5, Read: 3, Edit: 2, Grep: 1, you: 1 }, last: 0.2, started: 190,
    subagents: [
      { type: "general-purpose", description: "Run the forecast tests", model: "claude-sonnet-5-5", turns: 9, from: 21000, to: 158000, last: 0.3, running: true },
      { type: "Explore", description: "Find where the forecast picks its harbour", model: "claude-haiku-5-5", turns: 24, from: 18000, to: 236000, last: 40 },
      { type: "Plan", description: "Plan the picker's states", model: "claude-opus-5-5", turns: 6, from: 19000, to: 64000, last: 95 },
    ] },
  { title: "Move the station importer to the new tide API", cwd: WORKSPACE, status: "waiting", model: "claude-sonnet-5-5", effort: "high",
    segments: [{ turns: 64, from: 27100, to: 141800 }], out: 0.35, tools: { Bash: 4, Read: 4, WebFetch: 2, you: 1 }, last: 1.5, started: 75 },
  { title: "Why the moon phase lags by a day", cwd: WORKSPACE, status: "idle", model: "claude-opus-5-5", effort: "high",
    segments: [{ turns: 38, from: 30200, to: 71300 }], out: 0.45, tools: { Read: 4, Grep: 2, WebSearch: 2, you: 2 }, last: 13, started: 60 },
  { title: "Tests for the high-water rounding", cwd: WORKSPACE, status: "idle", model: "claude-fable-5-1", effort: "xhigh",
    segments: [{ turns: 232, from: 31000, to: 236400 }], out: 0.5, tools: { Bash: 6, Read: 3, Edit: 3, you: 1 }, last: 57, started: 240,
    subagents: [{ type: "Explore", description: "Find every rounding of a tide height", model: "claude-haiku-5-5", turns: 11, from: 17000, to: 48000, last: 150 }] },
  { title: "Rename the units setting", cwd: WORKSPACE, status: "idle", model: "claude-haiku-5-5", effort: null,
    segments: [{ turns: 14, from: 24300, to: 33800 }], out: 0.3, tools: { Edit: 3, Grep: 2, you: 1 }, last: 9, started: 35, ttl5mFrom: 11 },
  { title: "Draft the release notes for 0.9", cwd: WORKSPACE, status: "idle", model: "claude-opus-5-5", effort: "medium",
    segments: [{ turns: 46, from: 28800, to: 94100 }], out: 0.55, tools: { Bash: 2, Read: 3, you: 3 }, last: 185, started: 260 },
  { title: null, name: "tide-tables-07", cwd: WORKSPACE, status: "idle", started: 130 }, // a tab opened and never written to
  { title: "Scale the ingredient amounts by servings", cwd: "/Users/me/Dev/recipe-box", status: "busy", model: "claude-opus-5-5", effort: "xhigh",
    segments: [{ turns: 52, from: 26900, to: 86200 }], out: 0.4, tools: { Bash: 3, Read: 3, Edit: 3, you: 1 }, last: 0.4, started: 50 },
  { title: "Import recipes from a shared link", cwd: "/Users/me/Dev/recipe-box", status: "idle", model: "claude-sonnet-5-5", effort: "high",
    segments: [{ turns: 71, from: 26400, to: 103500 }], out: 0.35, tools: { WebFetch: 3, Bash: 3, Read: 2, you: 1 }, last: 25, started: 110 },
  { title: "Tidy the shell aliases", cwd: "/Users/me/Dev/dotfiles", status: "idle", model: "claude-haiku-5-5", effort: null,
    segments: [{ turns: 18, from: 22100, to: 41300 }], out: 0.3, tools: { Read: 2, Edit: 2, you: 1 }, last: 40, started: 70 },
];

/** A seeded generator (mulberry32), so every run writes the same transcripts. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, weights) {
  const entries = Object.entries(weights), total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [k, w] of entries) if ((r -= w) < 0) return k;
  return entries[entries.length - 1][0];
}

/**
 * The transcript lines of one session. Each segment's growth is split over its gaps by random weights; a gap's
 * growth is the previous turn's output read back (times 1.1, NOTES.md "Where the context grows") plus what entered,
 * written as characters at 2.05 per token, so the panel's estimate finds the sources it was given.
 */
function transcript(spec, index, now) {
  const rand = random(index + 1);
  const lines = [];
  let uuid = 0, msg = 0, tool = 0;
  const id = () => `e${index}-${++uuid}`;
  const turnsAll = spec.segments.reduce((a, s) => a + s.turns, 0);
  const first = now - (spec.started - 2) * MIN, last = now - spec.last * MIN;
  const at = (i) => new Date(first + ((last - first) * i) / Math.max(1, turnsAll - 1)).toISOString();
  const thinks = spec.model !== "claude-haiku-5-5";
  let turn = 0, tokens = 0, prevOut = 0;
  const user = (text, extra = {}) => lines.push({ type: "user", isSidechain: false, message: { role: "user", content: text }, uuid: id(), timestamp: at(turn), ...extra });
  user(`${spec.title}.`);
  if (spec.title) lines.push({ type: "ai-title", aiTitle: spec.title });
  spec.segments.forEach((seg, s) => {
    if (s > 0) {
      lines.push({ type: "system", subtype: "compact_boundary", isSidechain: false, uuid: id(), timestamp: at(turn),
        compactMetadata: { trigger: "auto", preTokens: tokens, postTokens: seg.from - spec.segments[0].from, durationMs: 41000 + Math.round(rand() * 20000) } });
      user("This session is being continued from a previous conversation.", { isCompactSummary: true });
    }
    const gaps = seg.turns - 1, growth = seg.to - seg.from;
    const outRaw = Array.from({ length: seg.turns }, () => 0.3 + rand() * 1.7);
    const inRaw = Array.from({ length: gaps }, () => (rand() < 0.08 ? 4 + rand() * 6 : 0.2 + rand() * 1.6)); // now and then a large result
    const outScale = (spec.out * growth) / (1.1 * outRaw.slice(0, gaps).reduce((a, b) => a + b, 0));
    const inScale = ((1 - spec.out) * growth) / inRaw.reduce((a, b) => a + b, 0);
    for (let i = 0; i < seg.turns; i++) {
      const out = Math.round(outRaw[i] * outScale), thinking = thinks ? Math.round(out * (0.2 + rand() * 0.4)) : 0;
      const entered = i === 0 ? 0 : Math.round(inRaw[i - 1] * inScale);
      const next = i === 0 ? seg.from : i === seg.turns - 1 ? seg.to : tokens + Math.round(prevOut * 1.1) + entered;
      const created = i === 0 ? next : Math.max(0, next - tokens);
      const ttl5m = spec.ttl5mFrom !== undefined && turn >= spec.ttl5mFrom;
      const source = i < gaps ? pick(rand, spec.tools) : null;
      const content = [{ type: "text", text: "." }];
      const toolId = `toolu_${index}_${++tool}`;
      if (source && source !== "you") content.push({ type: "tool_use", id: toolId, name: source, input: {} });
      lines.push({ type: "assistant", isSidechain: false, effort: spec.effort || undefined, uuid: id(), timestamp: at(turn),
        message: { id: `msg_${index}_${++msg}`, model: spec.model, role: "assistant", content,
          usage: { input_tokens: 4, cache_creation_input_tokens: created, cache_read_input_tokens: next - created - 4, output_tokens: out,
            output_tokens_details: { thinking_tokens: thinking },
            cache_creation: { ephemeral_1h_input_tokens: ttl5m ? 0 : created, ephemeral_5m_input_tokens: ttl5m ? created : 0 } } } });
      tokens = next; prevOut = out; turn += 1;
      if (!source) continue;
      const chars = Math.max(40, Math.round(Math.round(inRaw[i] * inScale) * 2.05));
      if (source === "you") user(".".repeat(chars));
      else lines.push({ type: "user", isSidechain: false, uuid: id(), timestamp: at(turn),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: ".".repeat(chars) }] } });
    }
  });
  return lines.map((l) => JSON.stringify(l));
}

/**
 * One invented subagent, as Claude Code lays it out in `<sessionId>/subagents/`: its transcript, every entry a sidechain
 * one, and its meta file, with `finished` unless it runs (it is written now, after its session's process started).
 */
function writeSubagent(dir, spec, index, sessionId, now) {
  const rand = random(100 + index);
  const agentId = `a${String(index + 1).padStart(16, "0")}`;
  const last = now - spec.last * MIN, first = last - spec.turns * 0.5 * MIN;
  const at = (i) => new Date(first + ((last - first) * i) / Math.max(1, spec.turns - 1)).toISOString();
  const lines = [{ type: "user", isSidechain: true, agentId, sessionId, uuid: `${agentId}-0`, timestamp: at(0), message: { role: "user", content: `${spec.description}.` } }];
  for (let i = 0; i < spec.turns; i++) {
    const tokens = Math.round(spec.from + ((spec.to - spec.from) * i) / Math.max(1, spec.turns - 1));
    lines.push({ type: "assistant", isSidechain: true, agentId, sessionId, uuid: `${agentId}-${i + 1}`, timestamp: at(i),
      message: { id: `msg_${agentId}_${i}`, model: spec.model, role: "assistant", content: [{ type: "text", text: "." }],
        usage: { input_tokens: 4, cache_creation_input_tokens: 800, cache_read_input_tokens: tokens - 804, output_tokens: Math.round(200 + rand() * 900) } } });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: spec.type, description: spec.description, spawnDepth: 1,
    ...(spec.running ? {} : { finished: true }) }));
}

/** Writes the registry, the transcripts and the subagents of SESSIONS into `claudeDir` as Claude Code lays them out. */
function writeClaudeDir(claudeDir, now) {
  fs.mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
  SESSIONS.forEach((spec, i) => {
    const pid = 41000 + i * 7;
    const sessionId = `de300000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    const project = path.join(claudeDir, "projects", core.projectSlug(spec.cwd));
    fs.mkdirSync(project, { recursive: true });
    const startedAt = now - spec.started * MIN;
    const name = spec.name || `${core.projectName(spec.cwd)}-${String(i + 1).padStart(2, "0")}`;
    fs.writeFileSync(path.join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: spec.cwd, startedAt,
      version: "2.1.310", kind: "interactive", entrypoint: "claude-vscode", name, nameSource: "derived", updatedAt: startedAt, status: spec.status }));
    if (spec.segments) fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), transcript(spec, i, now).join("\n") + "\n");
    (spec.subagents || []).forEach((agent, j) => writeSubagent(path.join(project, sessionId, "subagents"), agent, i * 10 + j, sessionId, now));
  });
  return { workspaceFolders: [WORKSPACE] };
}

/**
 * The two payloads (this workspace, all projects) and every session's detail, read by the real SessionReader. The
 * sessions are written relative to now, since the reader measures every age against the clock.
 */
function demoData() {
  const now = Date.now();
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-context-demo-"));
  try {
    const { workspaceFolders } = writeClaudeDir(claudeDir, now);
    const reader = new core.SessionReader(claudeDir, { alive: () => true });
    const read = (all) => { const { projectFolders, ...payload } = reader.read({ workspaceFolders, all }); return payload; };
    const workspace = read(false), all = read(true);
    const details = Object.fromEntries(all.sessions.map((s) => [s.sessionId, reader.detail(s.sessionId)]));
    return { workspace, all, details };
  } finally { fs.rmSync(claudeDir, { recursive: true, force: true }); }
}

/**
 * panel.html in the browser stand-in shared with server.cjs, with a host that answers "ready", "scope", "refresh" and
 * "detail" from `data` as extension.js would. The webview state starts from the URL's hash, a JSON object such as
 * {"compact":true} or {"open":"<sessionId>","all":true}, so a screenshot can start in any view.
 */
function demoPage(theme, data) {
  const host = `(deliver) => {
    const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};
    let state = {};
    try { state = JSON.parse(decodeURIComponent(location.hash.slice(1)) || "{}"); } catch {}
    let all = !!state.all;
    const list = (full) => deliver({ type: "sessions", ...(all ? DATA.all : DATA.workspace), full });
    return {
      getState: () => state,
      setState: (s) => { state = s; },
      postMessage: (msg) => {
        if (msg.type === "ready") list(false);
        if (msg.type === "refresh") list(true);
        if (msg.type === "scope") { all = !!msg.all; list(false); }
        if (msg.type === "detail") deliver({ type: "detail", sessionId: msg.sessionId, detail: DATA.details[msg.sessionId] || null });
      },
    };
  }`;
  return browserPage({ theme, host, nonce: "demo" });
}

// The README's images: a name, the width (the sidebar is about 400 px, four columns start at 620) and the view.
const SHOTS = [
  { name: "list", width: 400, state: {} },
  { name: "wide", width: 1180, state: { all: true } },
  { name: "compact", width: 400, state: { compact: true } },
  { name: "detail", width: 900, state: { open: 0 } },
];

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));

/**
 * Takes SHOTS with a headless Chrome over the DevTools protocol, each as tall as its page, at 2×. Dark theme only: the
 * owner chose one look for the README (2026-10-24); the light page stays in demo/ to check by eye.
 */
async function shoot(pages, data) {
  if (!CHROME) throw new Error("No Chrome found; open the pages in demo/ and take the screenshots by hand.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claude-context-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    let seq = 0;
    const waiting = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } });
    const call = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const open = data.workspace.sessions[0].sessionId;
    fs.mkdirSync(path.join(ROOT, "media"), { recursive: true });
    const theme = "dark";
    for (const shot of SHOTS) {
      const state = { ...shot.state, ...("open" in shot.state ? { open } : {}) };
      const metrics = (height) => call("Emulation.setDeviceMetricsOverride", { width: shot.width, height, deviceScaleFactor: 2, mobile: false });
      await metrics(200); // short, so scrollHeight is the page's and not the viewport's
      await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); // the pulse caught mid-ring looks like a smudge
      // a query per shot: a change of the hash alone would not load the page again
      await call("Page.navigate", { url: `${pathToFileURL(pages[theme]).href}?${shot.name}#${encodeURIComponent(JSON.stringify(state))}` });
      await sleep(700);
      const { result } = await call("Runtime.evaluate", { expression: "document.documentElement.scrollHeight" });
      await metrics(result.value);
      await sleep(200);
      const { data: png } = await call("Page.captureScreenshot", { format: "png" });
      const file = path.join(ROOT, "media", `${shot.name}.png`);
      fs.writeFileSync(file, Buffer.from(png, "base64"));
      console.log(path.relative(ROOT, file));
    }
    ws.close();
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  const data = demoData();
  const dir = path.join(ROOT, "demo");
  fs.mkdirSync(dir, { recursive: true });
  const pages = {};
  for (const theme of Object.keys(THEMES)) {
    pages[theme] = path.join(dir, `${theme}.html`);
    fs.writeFileSync(pages[theme], demoPage(theme, data));
    console.log(path.relative(ROOT, pages[theme]));
  }
  if (process.argv.includes("--shoot")) await shoot(pages, data);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { SESSIONS, WORKSPACE, writeClaudeDir, demoData, demoPage };
