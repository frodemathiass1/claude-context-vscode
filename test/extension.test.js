// test/extension.test.js — the VS Code host (src/extension.js), with a stand-in for the `vscode` module, which only
// the extension host has: the messages it answers, and how it follows the workspace folders, the setting and the
// view. The reader and the watcher are the real ones from core.cjs, on a Claude folder made from the fixtures.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const K = require("../src/core.cjs");

const EXT = fileURLToPath(new URL("../src/extension.js", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
// resolved, so the registry's cwd and the workspace folder compare as native paths on Windows too
const MINE = path.resolve("/Users/me/Dev/my-project"), OTHER = path.resolve("/Users/me/Dev/other-project");

const made = [], hosts = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.provider.dispose();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/**
 * A Claude folder with `sessions` ([sessionId, cwd, fixture]) live; the registry names this process, since the
 * extension's reader asks the OS whether the pid is alive.
 */
function claudeDir(sessions) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-context-extension-"));
  made.push(dir);
  mkdirSync(path.join(dir, "sessions"));
  sessions.forEach(([sessionId, cwd, fixture], i) => addSession(dir, `${i}`, sessionId, cwd, fixture));
  return dir;
}

function addSession(dir, file, sessionId, cwd, fixture) {
  writeFileSync(path.join(dir, "sessions", `${file}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd, status: "idle" }));
  const folder = path.join(dir, "projects", K.projectSlug(cwd));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${sessionId}.jsonl`), readFileSync(`${FIX}transcripts/${fixture}.jsonl`, "utf8"));
}

/** An event as vscode has them: subscribe with a listener, get a disposable; `fire` and `listeners` are the test's. */
function event() {
  const listeners = new Set();
  const subscribe = (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; };
  return Object.assign(subscribe, { listeners, fire: (e) => [...listeners].forEach((l) => l(e)) });
}

/** A webview view as VS Code resolves it: `posted` holds what the extension posts to the webview. */
function webviewView({ visible = true } = {}) {
  const posted = [];
  return { visible, posted, onDidChangeVisibility: event(), onDidDispose: event(),
    webview: { options: null, html: "", onDidReceiveMessage: event(), postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };
}

/**
 * extension.js activated with a stand-in for `vscode`: the setting `claudeContext.claudeDir` (`config`), the workspace
 * folders, and globalState. Its view is resolved at once, as VS Code does when the panel is first shown.
 */
function activate({ dir, folders = [MINE], visible = true } = {}) {
  const config = { claudeDir: dir };
  const workspace = {
    workspaceFolders: folders.map((fsPath) => ({ uri: { fsPath } })),
    getConfiguration: (section) => ({ get: (key) => (section === "claudeContext" ? config[key] : undefined) }),
    onDidChangeWorkspaceFolders: event(), onDidChangeConfiguration: event(),
  };
  let provider = null;
  const vscode = { workspace, window: { registerWebviewViewProvider: (id, p) => { provider = p; return { dispose() {} }; } } };
  const stored = new Map();
  const context = { subscriptions: [], globalState: { get: (k, d) => (stored.has(k) ? stored.get(k) : d), update: (k, v) => { stored.set(k, v); return Promise.resolve(); } } };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
  try { delete require.cache[EXT]; require(EXT).activate(context); } finally { Module._load = load; }
  const view = webviewView({ visible });
  provider.resolveWebviewView(view);
  const h = {
    config, workspace, stored, context, provider, view,
    lists: () => view.posted.filter((m) => m.type === "sessions"),
    last: () => h.lists().at(-1),
    ids: () => h.last().sessions.map((s) => s.sessionId),
    send: (msg) => view.webview.onDidReceiveMessage.fire(msg),
    show: (on) => { view.visible = on; view.onDidChangeVisibility.fire(); },
    configure: (...changed) => workspace.onDidChangeConfiguration.fire({ affectsConfiguration: (s) => changed.some((c) => c === s || c.startsWith(`${s}.`)) }),
  };
  hosts.push(h);
  return h;
}

const twoProjects = () => claudeDir([["aaaa-1", MINE, "with-title"], ["eeee-5", OTHER, "without-title"]]);

describe("extension.js: the messages", () => {
  it("resolving the view gives the webview the panel under its CSP and posts the list of the workspace", () => {
    const h = activate({ dir: twoProjects() });
    expect(h.view.webview.options).toEqual({ enableScripts: true, localResourceRoots: [] });
    const nonce = /script-src 'nonce-([^']+)'/.exec(h.view.webview.html)[1];
    expect(h.view.webview.html).toBe(K.panelPage({ nonce })); // the one builder, without the browser's connect-src and head
    expect(h.view.webview.html).not.toContain("connect-src");
    expect(h.view.webview.html).not.toContain("acquireVsCodeApi = ");
    expect(h.lists()).toHaveLength(1);
    expect(h.last()).toMatchObject({ all: false, full: false, count: 1, errors: [] });
    expect(h.ids()).toEqual(["aaaa-1"]);
  });

  it("ready, refresh (with full), scope (kept in globalState) and detail are answered", async () => {
    const h = activate({ dir: twoProjects() });
    h.send({ type: "ready" });
    expect(h.lists()).toHaveLength(2);
    expect(h.last().full).toBe(false);
    h.send({ type: "refresh" });
    expect(h.last().full).toBe(true);
    h.send({ type: "scope", all: true });
    await vi.waitFor(() => expect(h.last().all).toBe(true));
    expect(h.stored.get("claudeContext.allProjects")).toBe(true);
    expect(h.ids().sort()).toEqual(["aaaa-1", "eeee-5"]);
    h.send({ type: "detail", sessionId: "aaaa-1" });
    expect(h.view.posted.at(-1)).toMatchObject({ type: "detail", sessionId: "aaaa-1", detail: { turns: 2 } });
    h.send({ type: "detail", sessionId: "gone" });
    expect(h.view.posted.at(-1)).toEqual({ type: "detail", sessionId: "gone", detail: null });
    const before = h.view.posted.length;
    for (const msg of [null, "ready", { type: "detail", sessionId: 7 }, { type: "unknown" }]) h.send(msg);
    expect(h.view.posted).toHaveLength(before);
  });

  it("subagents: the list carries each session's summary and the detail its rows as SessionReader gives them, and their folder is watched", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // the detail's sinceMs is the same as the reader's below
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const dir = claudeDir([]);
    const folder = path.join(dir, "projects", K.projectSlug(MINE));
    writeFileSync(path.join(dir, "sessions", "0.json"), JSON.stringify({ pid: process.pid, sessionId: "bbbb-2", cwd: MINE, status: "busy" }));
    cpSync(`${FIX}subagents`, folder, { recursive: true });
    const h = activate({ dir });
    const reader = new K.SessionReader(dir, { alive: () => true });
    const expected = reader.read({ workspaceFolders: [MINE], all: false });
    expect(h.last().sessions).toEqual(expected.sessions);
    expect(h.last().sessions[0].subagents).toMatchObject({ count: 9, zone: "red" });
    h.send({ type: "detail", sessionId: "bbbb-2" });
    expect(h.view.posted.at(-1).detail).toEqual(reader.detail("bbbb-2"));
    expect(h.view.posted.at(-1).detail.subagentList).toHaveLength(9);
    expect([...h.provider.watcher.watchers.keys()]).toContain(path.join(folder, "bbbb-2", "subagents"));
  });
});

describe("extension.js: following the workspace and the setting", () => {
  it("a change of the workspace folders posts a list of the new scope", () => {
    const h = activate({ dir: twoProjects() });
    h.workspace.workspaceFolders = [{ uri: { fsPath: OTHER } }];
    h.workspace.onDidChangeWorkspaceFolders.fire({ added: [], removed: [] });
    expect(h.ids()).toEqual(["eeee-5"]);
    expect(h.last().workspaceNames).toEqual(["other-project"]);
  });

  it("a change of the setting reads from the new folder; a change of another setting does nothing", () => {
    const h = activate({ dir: twoProjects() });
    const old = h.provider.watcher;
    h.configure("editor.fontSize");
    expect(h.lists()).toHaveLength(1);
    expect(h.provider.watcher).toBe(old);
    h.config.claudeDir = claudeDir([["bbbb-2", MINE, "compaction"]]);
    h.configure("claudeContext.claudeDir");
    expect(h.lists()).toHaveLength(2);
    expect(h.ids()).toEqual(["bbbb-2"]);
    expect(old.watchers.size).toBe(0); // the watcher on the old folder is stopped
    expect(old.tick).toBeNull();
    expect(h.provider.watcher.claudeDir).toBe(h.config.claudeDir);
    expect(h.provider.watcher.tick).not.toBeNull();
  });
});

describe("extension.js: the view hidden and shown", () => {
  it("hidden, nothing is read or posted; shown again, the current list is posted at once", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const dir = twoProjects();
    const h = activate({ dir });
    vi.advanceTimersByTime(30000); // the tick, while shown
    expect(h.lists()).toHaveLength(2);
    h.show(false);
    expect(h.provider.watcher.watchers.size).toBe(0);
    expect(h.provider.watcher.tick).toBeNull();
    addSession(dir, "late", "cccc-3", MINE, "without-title");
    h.workspace.onDidChangeWorkspaceFolders.fire({ added: [], removed: [] });
    h.send({ type: "ready" });
    vi.advanceTimersByTime(120000);
    expect(h.lists()).toHaveLength(2);
    h.show(true);
    expect(h.lists()).toHaveLength(3);
    expect(h.ids().sort()).toEqual(["aaaa-1", "cccc-3"]);
    vi.advanceTimersByTime(30000); // the tick again
    expect(h.lists()).toHaveLength(4);
  });

  it("a view resolved hidden starts no watcher, and a setting changed while hidden is read when shown", () => {
    const h = activate({ dir: twoProjects(), visible: false });
    expect(h.lists()).toHaveLength(0);
    expect(h.provider.watcher.tick).toBeNull();
    h.config.claudeDir = claudeDir([["bbbb-2", MINE, "compaction"]]);
    h.configure("claudeContext.claudeDir");
    expect(h.lists()).toHaveLength(0);
    expect(h.provider.watcher.tick).toBeNull();
    h.show(true);
    expect(h.ids()).toEqual(["bbbb-2"]);
  });
});

describe("extension.js: disposal", () => {
  const listenerCounts = (h) => [h.view.onDidChangeVisibility, h.view.onDidDispose, h.view.webview.onDidReceiveMessage,
    h.workspace.onDidChangeWorkspaceFolders, h.workspace.onDidChangeConfiguration].map((e) => e.listeners.size);

  it("disposing the view stops the watcher and its timers and drops every listener", () => {
    const h = activate({ dir: twoProjects() });
    expect(listenerCounts(h)).toEqual([1, 1, 1, 1, 1]);
    expect(h.provider.watcher.watchers.size).toBeGreaterThan(0);
    h.view.onDidDispose.fire();
    expect(listenerCounts(h)).toEqual([0, 0, 0, 0, 0]);
    expect(h.provider.watcher.watchers.size).toBe(0);
    expect(h.provider.watcher.tick).toBeNull();
    expect(h.provider.watcher.timer).toBeNull();
    h.workspace.onDidChangeWorkspaceFolders.fire({ added: [], removed: [] });
    expect(h.lists()).toHaveLength(1);
  });

  it("a view resolved again drops the listeners of the one before", () => {
    const h = activate({ dir: twoProjects() });
    const second = webviewView();
    h.provider.resolveWebviewView(second);
    expect(listenerCounts(h).slice(0, 3)).toEqual([0, 0, 0]);
    expect(listenerCounts(h).slice(3)).toEqual([1, 1]);
    h.workspace.onDidChangeWorkspaceFolders.fire({ added: [], removed: [] });
    expect(second.posted.filter((m) => m.type === "sessions")).toHaveLength(2);
    expect(h.lists()).toHaveLength(1);
  });

  it("deactivating disposes the provider through the extension's subscriptions", () => {
    const h = activate({ dir: twoProjects() });
    for (const d of h.context.subscriptions) d.dispose();
    expect(listenerCounts(h)).toEqual([0, 0, 0, 0, 0]);
    expect(h.provider.watcher.tick).toBeNull();
  });
});
