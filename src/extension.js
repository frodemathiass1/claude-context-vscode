// src/extension.js — the extension host side of the "Claude Context" panel. Reads the data with core.cjs
// and watches Claude Code's sessions/ and projects/ folders with it (SessionReader and SessionWatcher),
// and pushes the list to the webview with postMessage (the webview cannot read files itself), and answers
// the detail view's request for every turn of one session.
// CommonJS, because the extension host loads it that way. Install with
// "Developer: Install Extension from Location…" (see README.md).
"use strict";

const vscode = require("vscode");
const core = require("./core.cjs");

const VIEW_ID = "claudeContext.panel";
const SCOPE_KEY = "claudeContext.allProjects";
const DIR_SETTING = "claudeContext.claudeDir";
/** The folder Claude Code stores its data in: the setting, else CLAUDE_CONFIG_DIR, else ~/.claude. */
function claudeDir() {
  return core.claudeDir(vscode.workspace.getConfiguration("claudeContext").get("claudeDir"));
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
    this.listeners = []; // the view's and the workspace's, disposed with the view
    this.use(claudeDir());
  }

  /** A reader and a watcher on `dir`, in place of the ones before; the watcher runs only while the view is shown. */
  use(dir) {
    if (this.watcher) this.watcher.stop();
    this.reader = new core.SessionReader(dir);
    this.watcher = new core.SessionWatcher(dir, () => this.refresh());
    if (this.view && this.view.visible) this.watcher.start();
  }

  resolveWebviewView(view) {
    this.disposeView(); // a view resolved again: the listeners of the one before go
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = core.panelPage();
    this.listeners.push(
      view.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      // hidden, the webview keeps its context (retainContextWhenHidden) but nothing is read for it; shown again,
      // one read catches up, since the reader keeps its parsed state
      view.onDidChangeVisibility(() => {
        if (!view.visible) { this.watcher.stop(); return; }
        this.watcher.start();
        this.refresh();
      }),
      view.onDidDispose(() => this.disposeView()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()), // the folders are the scope "This workspace"
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(DIR_SETTING)) return;
        this.use(claudeDir());
        this.refresh();
      }),
    );
    if (view.visible) this.watcher.start();
    this.refresh();
  }

  onMessage(msg) {
    core.answerPanel(msg, {
      refresh: (full) => this.refresh({ full }),
      keepScope: (all) => this.context.globalState.update(SCOPE_KEY, all),
      reader: () => this.reader,
      post: (m) => { if (this.view) this.view.webview.postMessage(m); },
    });
  }

  refresh({ full = false } = {}) {
    if (!this.view || !this.view.visible) return; // hidden: the next show reads
    const all = !!this.context.globalState.get(SCOPE_KEY, false);
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const list = core.readSessions(this.reader, { workspaceFolders, all, full });
    if (!list) return;
    this.watcher.watchAll(list.projectFolders);
    this.view.webview.postMessage(list);
  }

  disposeView() {
    for (const listener of this.listeners.splice(0)) listener.dispose();
    this.view = null;
    this.watcher.stop();
  }

  dispose() { this.disposeView(); }
}

module.exports = { activate, deactivate };
