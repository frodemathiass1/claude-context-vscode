// extension.js — the extension host side of the "Claude Context" panel. Reads the data with core.cjs
// and watches Claude Code's sessions/ and projects/ folders with it (SessionReader and SessionWatcher),
// and pushes the list to the webview with postMessage (the webview cannot read files itself).
// CommonJS, because the extension host loads it that way. Install with
// "Developer: Install Extension from Location…" (see README.md).
"use strict";

const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./core.cjs");

const VIEW_ID = "claudeContext.panel";
const SCOPE_KEY = "claudeContext.allProjects";
const DEBOUNCE_MS = 250;
const TICK_MS = 30000; // refreshes "x min ago" and catches processes that died without removing their file
/** The folder Claude Code stores its data in: the setting, else CLAUDE_CONFIG_DIR, else ~/.claude. Read at activation. */
function claudeDir() {
  const setting = String(vscode.workspace.getConfiguration("claudeContext").get("claudeDir") || "").trim();
  return setting || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function activate(context) {
  const provider = new ClaudeContextViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    provider,
  );
}

function deactivate() {}

class ClaudeContextViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    const dir = claudeDir();
    this.reader = new core.SessionReader(dir);
    this.watcher = new core.SessionWatcher(dir,() => this.refresh(), { debounceMs: DEBOUNCE_MS, tickMs: TICK_MS });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") this.refresh();
      if (msg.type === "refresh") this.refresh({ full: true }); // the panel's button: forget the parsed state, read everything again
      if (msg.type === "scope") this.context.globalState.update(SCOPE_KEY, !!msg.all).then(() => this.refresh());
    });
    view.onDidDispose(() => { this.view = null; this.stopWatching(); });
    this.startWatching();
    this.refresh();
  }

  renderHtml() {
    const nonce = randomNonce();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">`;
    return fs.readFileSync(path.join(__dirname, "panel.html"), "utf8")
      .replace("<!-- csp -->", csp)
      .replace(/\{\{nonce\}\}/g, nonce);
  }

  refresh({ full = false } = {}) {
    if (!this.view) return;
    const all = !!this.context.globalState.get(SCOPE_KEY, false);
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const payload = this.reader.read({ workspaceFolders, all, full });
    this.watchProjectFolders(payload.projectFolders);
    this.view.webview.postMessage({ type: "sessions", ...payload, full }); // full: the panel's refresh receipt keys on it
  }

  startWatching() { this.watcher.start(); }

  watchProjectFolders(folders) { this.watcher.watchAll(folders); }

  stopWatching() { this.watcher.stop(); }

  dispose() { this.stopWatching(); }
}

function randomNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = { activate, deactivate };
