// extension.js — the extension host side of the "Claude Context" panel. Reads the data with core.cjs
// and watches Claude Code's sessions/ and projects/ folders with it (SessionReader and SessionWatcher),
// and pushes the list to the webview with postMessage (the webview cannot read files itself), and answers
// the detail view's request for every turn of one session.
// CommonJS, because the extension host loads it that way. Install with
// "Developer: Install Extension from Location…" (see README.md).
"use strict";

const vscode = require("vscode");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./core.cjs");

const VIEW_ID = "claudeContext.panel";
const SCOPE_KEY = "claudeContext.allProjects";
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
    this.watcher = new core.SessionWatcher(dir, () => this.refresh());
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
      // the detail view asks for every turn of the open session after each list; the answer is the last read's
      if (msg.type === "detail" && typeof msg.sessionId === "string") {
        this.view.webview.postMessage({ type: "detail", sessionId: msg.sessionId, detail: this.reader.detail(msg.sessionId) });
      }
    });
    view.onDidDispose(() => { this.view = null; this.watcher.stop(); });
    this.watcher.start();
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
    // called from the watcher's timers too: an exception there would land in the extension host, so the
    // panel keeps its last list instead and the error goes to the extension host log
    let payload;
    try { payload = this.reader.read({ workspaceFolders, all, full }); }
    catch (e) { console.error("Claude Context: reading the sessions failed", e); return; }
    this.watcher.watchAll(payload.projectFolders);
    this.view.webview.postMessage({ type: "sessions", ...payload, full }); // full: the panel's refresh receipt keys on it
  }

  dispose() { this.watcher.stop(); }
}

/** A CSP nonce: unguessable, so only the panel's own inline style and script run. */
function randomNonce() {
  return crypto.randomBytes(16).toString("base64");
}

module.exports = { activate, deactivate };
