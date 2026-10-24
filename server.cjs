#!/usr/bin/env node
// server.cjs — the browser host of the "Claude Context" panel, beside the VS Code one (extension.js): the same
// SessionReader and SessionWatcher from core.cjs and the same panel.html, served to this machine only. The page
// talks to it with the panel's messages: `ready`, `refresh`, `scope` and `detail` come in as POST /message,
// `sessions` and `detail` go out as Server-Sent Events on GET /events (fetch and EventSource need no library; a
// WebSocket would).
//
// The transcripts hold the user's conversations, so the server listens on 127.0.0.1 only, and every request must
// carry the random token printed in the URL (as Jupyter does, so another page in the browser cannot read /events)
// and a Host of 127.0.0.1 or localhost with the server's port (DNS rebinding); a POST must come from the server's
// own Origin. No CORS headers are sent.
//
//   node server.cjs [folder…] [--port <n>] [--claude-dir <dir>] [--no-open]
//
// This file also holds the browser stand-in for the webview (the --vscode-* theme variables and acquireVsCodeApi),
// which scripts/demo.cjs uses for its pages too.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const core = require("./core.cjs");

const PANEL = path.join(__dirname, "panel.html");
// A fixed port by default, not any free one: localStorage, where the page keeps its choices, belongs to the
// origin, port included, so a new port on every start would forget them. A free one is taken when it is busy.
const DEFAULT_PORT = 7419;
const BODY_MAX = 64 * 1024; // the largest message the panel sends is a few dozen bytes
const CLIENT_ID = /^[0-9a-f]{32}$/; // made by the page, see browserHost
const USAGE = `Usage: node server.cjs [folder…] [--port <n>] [--claude-dir <dir>] [--no-open]

  folder…            the folders that make up "This workspace"; none: every live session is listed
  --port <n>         the port on 127.0.0.1; 0 for any free one (default ${DEFAULT_PORT}, or a free one when it is taken)
  --claude-dir <dir> the folder Claude Code stores its data in (default CLAUDE_CONFIG_DIR, else ~/.claude)
  --no-open          print the URL without opening it in the browser`;

// ── The browser stand-in for the webview, shared with scripts/demo.cjs ──

// The --vscode-* variables the panel reads, from VS Code's Light Modern and Dark Modern themes, and the system font
// (the macOS one first, as in VS Code; the screenshots are taken there).
const FONT = { "font-family": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, sans-serif", "font-size": "13px",
  "editor-font-family": "Menlo, Monaco, Consolas, \"Ubuntu Mono\", monospace" };
const THEMES = {
  light: { ...FONT, "sideBar-background": "#f8f8f8", foreground: "#3b3b3b", descriptionForeground: "#3b3b3b", "sideBarSectionHeader-border": "#e5e5e5",
    "sideBarSectionHeader-foreground": "#3b3b3b", "widget-border": "#e5e5e5", "editorWidget-border": "#c8c8c8", "editorWidget-background": "#f8f8f8",
    "list-hoverBackground": "#f2f2f2", "charts-green": "#388a34", "charts-yellow": "#bf8803", "charts-red": "#e51400", "charts-lines": "rgba(97, 97, 97, 0.5)",
    "badge-background": "#cccccc", "badge-foreground": "#3b3b3b", focusBorder: "#005fb8" },
  dark: { ...FONT, "sideBar-background": "#181818", foreground: "#cccccc", descriptionForeground: "#9d9d9d", "sideBarSectionHeader-border": "#2b2b2b",
    "sideBarSectionHeader-foreground": "#cccccc", "widget-border": "#313131", "editorWidget-border": "#454545", "editorWidget-background": "#202020",
    "list-hoverBackground": "#2a2d2e", "charts-green": "#89d185", "charts-yellow": "#cca700", "charts-red": "#f14c4c", "charts-lines": "rgba(204, 204, 204, 0.5)",
    "badge-background": "#616161", "badge-foreground": "#f8f8f8", focusBorder: "#0078d4" },
};

/** The theme's variables on the page; "auto" gives both, the dark ones under prefers-color-scheme: dark. */
function themeCss(theme) {
  const vars = (name) => `color-scheme: ${name}; ${Object.entries(THEMES[name]).map(([k, v]) => `--vscode-${k}: ${v};`).join(" ")}`;
  const page = "background: var(--vscode-sideBar-background);";
  if (theme !== "auto") return `html { ${vars(theme)} ${page} }`;
  return `html { ${vars("light")} ${page} }\n@media (prefers-color-scheme: dark) { html { ${vars("dark")} } }`;
}

/**
 * panel.html as a browser page: the theme's variables (see themeCss) and a stand-in for acquireVsCodeApi. `host` is
 * the source of a function that takes `deliver` (which hands a message to the panel, as the webview's host would)
 * and returns { getState, setState, postMessage }. `connect` lets the page reach its own origin (fetch,
 * EventSource); without it the CSP is the webview's.
 */
function browserPage({ theme, host, connect = false, nonce = randomNonce() }) {
  const standIn = `
  (() => {
    const deliver = (msg) => setTimeout(() => window.postMessage(msg, "*"));
    const api = (${host})(deliver);
    window.acquireVsCodeApi = () => api;
  })();`;
  const head = `<meta http-equiv="Content-Security-Policy" content="${pageCsp(nonce, connect)}">
<style nonce="${nonce}">${themeCss(theme)}</style>
<script nonce="${nonce}">${standIn}</script>`;
  // a function, so a "$&" in the host's source is not a replacement pattern
  return fs.readFileSync(PANEL, "utf8").replace("<!-- csp -->", () => head).replace(/\{\{nonce\}\}/g, nonce);
}

function pageCsp(nonce, connect) {
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';${connect ? " connect-src 'self';" : ""}`;
}

/**
 * The host in the server's page. It runs in the browser (its source is embedded in the page), so it uses only what
 * a page has. getState and setState keep the webview state in localStorage, and so does a scope switch, where VS
 * Code keeps it in globalState; postMessage is a POST to /message, and the events on /events go to the panel. The
 * page names itself with a random client id, so each tab has its own scope. A message sent before the event stream
 * is open waits for it, so the server knows the page before `ready` arrives. When the stream drops, the last list
 * comes back with an error line, so the panel does not go on as if it were live.
 */
function browserHost(deliver) {
  const STATE = "claudeContext.state", SCOPE = "claudeContext.allProjects";
  const load = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off: the choice lasts this page */ } };
  let state = load(STATE);
  const token = new URLSearchParams(location.search).get("token") || "";
  const client = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const query = (extra) => `?${new URLSearchParams({ token, client, ...extra })}`;
  const send = (msg) => fetch(`message${query()}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) }).catch(() => {});
  let open = false, opened = false, last = null;
  const queued = [];
  const events = new EventSource(`events${query({ all: load(SCOPE) ? "1" : "0" })}`);
  events.onopen = () => {
    open = true;
    if (opened) send({ type: "scope", all: !!load(SCOPE) }); // a new stream after a drop: the server forgot the page; this also sends the list
    opened = true;
    queued.splice(0).forEach(send);
  };
  events.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg && msg.type === "sessions") last = msg;
    deliver(msg);
  };
  events.onerror = () => {
    if (!open) return; // EventSource retries every 2 s; the panel hears of the drop once
    open = false;
    if (last) deliver({ ...last, full: false, errors: [...(last.errors || []), "No connection to the server: is node server.cjs still running? Start it again and open the URL it prints."] });
  };
  return {
    getState: () => state,
    setState: (s) => { state = s; save(STATE, s); },
    postMessage: (msg) => {
      if (msg && msg.type === "scope") save(SCOPE, !!msg.all);
      if (open) send(msg); else queued.push(msg);
    },
  };
}

/** A CSP nonce: unguessable, so only the panel's own inline style and script run. */
function randomNonce() {
  return crypto.randomBytes(16).toString("base64");
}

// ── The server ──

/**
 * The command line: folders, resolved against `cwd`; the port (null: DEFAULT_PORT, else a free one); the Claude
 * folder as in VS Code (the flag, else CLAUDE_CONFIG_DIR, else ~/.claude). Throws on a flag it does not know.
 */
function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const opts = { folders: [], port: null, claudeDir: null, open: true, help: false };
  const value = (i, flag) => { if (i >= argv.length) throw new Error(`${flag} needs a value`); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const n = Number(value(++i, a));
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Not a port: ${argv[i]}`);
      opts.port = n;
    } else if (a === "--claude-dir") opts.claudeDir = path.resolve(cwd, value(++i, a));
    else if (a === "--no-open") opts.open = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    else opts.folders.push(path.resolve(cwd, a));
  }
  opts.claudeDir = opts.claudeDir || (env.CLAUDE_CONFIG_DIR ? path.resolve(cwd, env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude"));
  return opts;
}

/**
 * Starts the server on 127.0.0.1. `folders` are "This workspace" (none: every live session, as in a VS Code window
 * without a folder); `port` null tries DEFAULT_PORT, then a free one; `alive` and `tickMs` are for the tests.
 * Resolves to { server, url, port, token, close }.
 */
async function startServer({ claudeDir, folders = [], port = null, alive, tickMs } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  // one reader per scope: a read forgets the parsed state of the sessions outside its scope, so two tabs in
  // different scopes sharing one would read every transcript from its first byte on every change
  const readers = new Map();
  const readerFor = (all) => { if (!readers.has(all)) readers.set(all, new core.SessionReader(claudeDir, { alive })); return readers.get(all); };
  const clients = new Map(); // client id → { res, all }
  const watched = new Map(); // all → the project folders of that scope's last read
  const watcher = new core.SessionWatcher(claudeDir, () => refresh(), { tickMs });

  const push = (client, msg) => client.res.write(`data: ${JSON.stringify(msg)}\n\n`);

  /** Reads each scope the pages are in (or only `client`'s) and sends the list to every page in it, as extension.js does. */
  function refresh({ client = null, full = false } = {}) {
    for (const all of new Set((client ? [client] : [...clients.values()]).map((c) => c.all))) {
      // called from the watcher's timers too: an exception there would end the server, so the pages keep their last list
      let payload;
      try { payload = readerFor(all).read({ workspaceFolders: folders, all, full }); }
      catch (e) { console.error("Claude Context: reading the sessions failed", e); continue; }
      watched.set(all, payload.projectFolders);
      for (const c of clients.values()) if (c.all === all) push(c, { type: "sessions", ...payload, full: full && c === client }); // full: the requester's refresh receipt
    }
    const scopes = new Set([...clients.values()].map((c) => c.all));
    watcher.watchAll([...new Set([...watched].filter(([all]) => scopes.has(all)).flatMap(([, f]) => f))]);
  }

  function onMessage(client, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") refresh({ client });
    if (msg.type === "refresh") refresh({ client, full: true }); // the panel's button: forget the parsed state, read everything again
    if (msg.type === "scope") { client.all = !!msg.all; refresh({ client }); }
    // the detail view asks for every turn of the open session after each list; the answer is the last read's of its scope
    if (msg.type === "detail" && typeof msg.sessionId === "string") {
      push(client, { type: "detail", sessionId: msg.sessionId, detail: readerFor(client.all).detail(msg.sessionId) });
    }
  }

  const server = http.createServer((req, res) => {
    const own = server.address().port;
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${own}` && host !== `localhost:${own}`) return refuse(res, 403, "Host not allowed"); // DNS rebinding
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return refuse(res, 400, "Bad request"); }
    if (!sameToken(url.searchParams.get("token"), token)) return refuse(res, 403, "Wrong or missing token");
    if (url.pathname === "/") {
      if (req.method !== "GET") return refuse(res, 405, "Method not allowed");
      const nonce = randomNonce();
      res.writeHead(200, headers({ "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `${pageCsp(nonce, true)} frame-ancestors 'none'; base-uri 'none'; form-action 'none';` }));
      return res.end(browserPage({ theme: "auto", host: browserHost.toString(), connect: true, nonce }));
    }
    const id = url.searchParams.get("client");
    if (url.pathname === "/events") {
      if (req.method !== "GET") return refuse(res, 405, "Method not allowed");
      if (!CLIENT_ID.test(id || "")) return refuse(res, 400, "Bad client id");
      res.writeHead(200, headers({ "Content-Type": "text/event-stream; charset=utf-8" }));
      res.write("retry: 2000\n\n");
      const before = clients.get(id);
      if (before) before.res.end();
      const client = { res, all: url.searchParams.get("all") === "1" };
      clients.set(id, client);
      req.on("close", () => { if (clients.get(id) === client) clients.delete(id); });
      return;
    }
    if (url.pathname === "/message") {
      if (req.method !== "POST") return refuse(res, 405, "Method not allowed");
      if (req.headers.origin !== `http://${host}`) return refuse(res, 403, "Origin not allowed");
      if (!/^application\/json\b/.test(String(req.headers["content-type"] || ""))) return refuse(res, 415, "Expected application/json");
      const client = clients.get(id);
      if (!client) return refuse(res, 404, "No event stream for this client");
      return readBody(req, (err, body) => {
        if (err) return refuse(res, 413, "Message too large");
        let msg;
        try { msg = JSON.parse(body); } catch { return refuse(res, 400, "Not JSON"); }
        onMessage(client, msg);
        res.writeHead(204, headers()).end();
      });
    }
    refuse(res, 404, "Not found");
  });

  const listen = (p) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  if (port === null) {
    try { await listen(DEFAULT_PORT); }
    catch (e) { if (e.code !== "EADDRINUSE") throw e; await listen(0); }
  } else await listen(port);
  watcher.start();
  const actual = server.address().port;
  return {
    server, url: `http://127.0.0.1:${actual}/?token=${token}`, port: actual, token,
    close: () => new Promise((resolve) => {
      watcher.stop();
      for (const c of clients.values()) c.res.end();
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** Headers on every answer: never cached, never framed, no referrer (the URL holds the token), no CORS. */
function headers(extra = {}) {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", ...extra };
}

function refuse(res, status, text) {
  res.writeHead(status, headers({ "Content-Type": "text/plain; charset=utf-8" })).end(`${text}\n`);
}

/** Compared in constant time, so the token cannot be guessed a character at a time. */
function sameToken(given, token) {
  if (typeof given !== "string" || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function readBody(req, done) {
  const chunks = [];
  let size = 0, failed = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > BODY_MAX) { failed = true; req.destroy(); done(new Error("too large")); return; }
    chunks.push(chunk);
  });
  req.on("end", () => { if (!failed) done(null, Buffer.concat(chunks).toString("utf8")); });
}

/** Opens the URL in the default browser; a failure only means the user opens the printed URL by hand. */
function openBrowser(url) {
  // the URL is hex and punctuation only, so cmd's start sees no & or ^ in it
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* see above */ }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
  if (opts.help) { console.log(USAGE); return; }
  if (!fs.existsSync(path.join(opts.claudeDir, "sessions"))) console.warn(`No sessions folder in ${opts.claudeDir}; is Claude Code's folder elsewhere? (--claude-dir)`);
  const { url, close } = await startServer(opts);
  console.log(opts.folders.length ? `This workspace: ${opts.folders.join(", ")}` : "No folder given: every live session on this machine is listed.");
  console.log(`Claude Context: ${url}`);
  console.log("Ctrl+C stops it.");
  if (opts.open) openBrowser(url);
  const stop = () => close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { THEMES, DEFAULT_PORT, themeCss, browserPage, browserHost, parseArgs, startServer };
