// test/server.test.js — the browser host (server.cjs): the panel served on 127.0.0.1 behind a token, the messages
// over POST /message and Server-Sent Events, the scope, and the browser stand-in it shares with scripts/demo.cjs.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const K = require("../core.cjs");
const S = require("../server.cjs");

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
// resolved, so the registry's cwd and the folder given compare as native paths on Windows too
const MINE = path.resolve("/Users/me/Dev/my-project"), OTHER = path.resolve("/Users/me/Dev/other-project");
const alive = () => true;

/** A Claude folder with one live session in each of two projects, the transcripts taken from the fixtures. */
function claudeDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-context-server-"));
  mkdirSync(path.join(dir, "sessions"));
  const put = (pid, sessionId, cwd, fixture) => {
    writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, status: "idle" }));
    const folder = path.join(dir, "projects", K.projectSlug(cwd));
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${sessionId}.jsonl`), readFileSync(`${FIX}transcripts/${fixture}.jsonl`, "utf8"));
  };
  put(1303, "aaaa-1", MINE, "with-title");
  put(5555, "eeee-5", OTHER, "without-title");
  return dir;
}

/** One request with http (fetch will not set Host); resolves to { status, headers, body }. */
function request(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A page's two ends: the event stream, read message by message, and post(msg) as the page's fetch sends it. */
async function page(srv, { all = false } = {}) {
  const client = crypto.randomBytes(16).toString("hex");
  const query = `token=${srv.token}&client=${client}`;
  const messages = [], waiting = [];
  const res = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: srv.port, path: `/events?${query}&all=${all ? 1 : 0}`, headers: { host: `127.0.0.1:${srv.port}` } }, resolve).on("error", reject);
  });
  let buffer = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (data) messages.push(JSON.parse(data));
      for (const w of waiting.splice(0)) w();
    }
  });
  /** The next message of `type` not yet taken. */
  const next = async (type) => {
    for (;;) {
      const i = messages.findIndex((m) => m.type === type);
      if (i >= 0) return messages.splice(i, 1)[0];
      await new Promise((resolve) => waiting.push(resolve));
    }
  };
  const post = (msg, headers = {}, body = JSON.stringify(msg)) => request(srv.port, `/message?${query}`, { method: "POST", body,
    headers: { origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json", ...headers } });
  return { res, status: res.statusCode, next, post, close: () => res.destroy() };
}

describe("server.cjs", () => {
  let dir;
  beforeAll(() => {
    dir = claudeDir();
    // the clock stands still, so a list read here is the same as the one the server sent (sinceMs, generatedAt)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = (folders = []) => S.startServer({ claudeDir: dir, folders, port: 0, alive, tickMs: 3600000 });

  it("listens on 127.0.0.1 only, on the port asked for (0: a free one), and prints a URL with the token", async () => {
    const srv = await start();
    try {
      expect(srv.server.address().address).toBe("127.0.0.1");
      expect(srv.port).toBeGreaterThan(0);
      expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/?token=${srv.token}`);
      expect(srv.token).toMatch(/^[0-9a-f]{48}$/);
    } finally { await srv.close(); }
  });

  it("without a port it takes the default one, or a free one when that is taken", async () => {
    const a = await S.startServer({ claudeDir: dir, alive, tickMs: 3600000 });
    const b = await S.startServer({ claudeDir: dir, alive, tickMs: 3600000 });
    try {
      expect(b.port).not.toBe(a.port); // a has the default port unless something else holds it; b never does
      expect(b.port).not.toBe(S.DEFAULT_PORT);
      expect(b.server.address().address).toBe("127.0.0.1");
    } finally { await a.close(); await b.close(); }
  });

  it("GET / with the token serves the panel with its stand-in and CSP; without the token, or with a wrong one, it is refused", async () => {
    const srv = await start();
    try {
      const ok = await request(srv.port, `/?token=${srv.token}`);
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(ok.body).toContain("window.acquireVsCodeApi");
      expect(ok.body).toContain("function browserHost(deliver)");
      expect(ok.body).toContain("@media (prefers-color-scheme: dark)");
      expect(ok.body).not.toContain("{{nonce}}");
      expect(ok.headers["content-security-policy"]).toContain("connect-src 'self'");
      expect(ok.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
      expect((await request(srv.port, "/")).status).toBe(403);
      expect((await request(srv.port, `/?token=${"0".repeat(48)}`)).status).toBe(403);
      expect((await request(srv.port, `/?token=${srv.token.slice(1)}`)).status).toBe(403);
      expect((await request(srv.port, `/events?client=${"a".repeat(32)}`)).status).toBe(403);
    } finally { await srv.close(); }
  });

  it("a Host other than 127.0.0.1:<port> or localhost:<port> is refused; a POST from a foreign Origin, or none, is refused", async () => {
    const srv = await start();
    const p = await page(srv);
    try {
      const at = `/?token=${srv.token}`;
      expect((await request(srv.port, at, { headers: { host: `localhost:${srv.port}` } })).status).toBe(200);
      expect((await request(srv.port, at, { headers: { host: `evil.example:${srv.port}` } })).status).toBe(403); // DNS rebinding
      expect((await request(srv.port, at, { headers: { host: "127.0.0.1:1" } })).status).toBe(403);
      expect((await request(srv.port, at, { headers: { host: "127.0.0.1" } })).status).toBe(403);
      expect((await p.post({ type: "ready" }, { origin: "http://evil.example" })).status).toBe(403);
      expect((await p.post({ type: "ready" }, { origin: `http://127.0.0.1:${srv.port + 1}` })).status).toBe(403);
      expect((await p.post({ type: "ready" }, { origin: "" })).status).toBe(403);
      expect((await p.post({ type: "ready" }, { "content-type": "text/plain" })).status).toBe(415); // a form or no-cors fetch could send that
      expect((await p.post({ type: "ready" })).status).toBe(204);
    } finally { p.close(); await srv.close(); }
  });

  it("a POST for a page without an event stream, or a body that is not JSON, is refused", async () => {
    const srv = await start();
    const p = await page(srv);
    try {
      const other = `/message?token=${srv.token}&client=${"b".repeat(32)}`;
      const headers = { origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json" };
      expect((await request(srv.port, other, { method: "POST", headers, body: "{}" })).status).toBe(404);
      expect((await request(srv.port, `/message?token=${srv.token}&client=x`, { method: "POST", headers, body: "{}" })).status).toBe(404);
      expect((await p.post(null, {}, "{")).status).toBe(400);
      expect((await p.post(null, {}, "x".repeat(70 * 1024)).catch(() => ({ status: 413 }))).status).toBe(413); // the socket may close first
      expect((await p.post({ type: "nothing-known" })).status).toBe(204); // ignored, as the VS Code host does
    } finally { p.close(); await srv.close(); }
  });

  it("ready gives a sessions event with the payload SessionReader.read gives; scope all switches the list; detail answers for the session asked", async () => {
    const srv = await start([MINE]);
    const p = await page(srv);
    try {
      await p.post({ type: "ready" });
      const reader = new K.SessionReader(dir, { alive });
      const expected = reader.read({ workspaceFolders: [MINE], all: false });
      expect(await p.next("sessions")).toEqual({ type: "sessions", ...expected, full: false });

      await p.post({ type: "scope", all: true });
      const all = await p.next("sessions");
      expect(all).toEqual({ type: "sessions", ...new K.SessionReader(dir, { alive }).read({ workspaceFolders: [MINE], all: true }), full: false });
      expect(all.groups.map((g) => g.project).sort()).toEqual(["my-project", "other-project"]);

      await p.post({ type: "detail", sessionId: "eeee-5" });
      const detail = await p.next("detail");
      expect(detail.sessionId).toBe("eeee-5");
      reader.read({ workspaceFolders: [MINE], all: true });
      expect(detail.detail).toEqual(reader.detail("eeee-5"));
      expect(detail.detail.turns).toBeGreaterThan(0);

      await p.post({ type: "refresh" });
      expect((await p.next("sessions")).full).toBe(true); // the panel's refresh receipt
    } finally { p.close(); await srv.close(); }
  });

  it("with no folder given every live session is listed; with a folder given only the sessions started inside it", async () => {
    const none = await start();
    const mine = await start([MINE]);
    const a = await page(none), b = await page(mine);
    try {
      await a.post({ type: "ready" });
      await b.post({ type: "ready" });
      const everything = await a.next("sessions");
      expect(everything.sessions.map((s) => s.sessionId).sort()).toEqual(["aaaa-1", "eeee-5"]);
      expect(everything.workspaceNames).toEqual([]);
      const inside = await b.next("sessions");
      expect(inside.sessions.map((s) => s.sessionId)).toEqual(["aaaa-1"]);
      expect(inside.workspaceNames).toEqual(["my-project"]);
      expect(inside.hiddenCount).toBe(1);
    } finally { a.close(); b.close(); await none.close(); await mine.close(); }
  });

  it("each page has its own scope: the scope in the events URL is where it starts, and a switch in one page leaves the other", async () => {
    const srv = await start([MINE]);
    const a = await page(srv), b = await page(srv, { all: true });
    try {
      await b.post({ type: "ready" });
      expect((await b.next("sessions")).all).toBe(true);
      await a.post({ type: "ready" });
      expect((await a.next("sessions")).all).toBe(false);
      await a.post({ type: "scope", all: true });
      await a.post({ type: "scope", all: false });
      await b.post({ type: "ready" });
      let last;
      do last = await b.next("sessions"); while (!last.all || last.count !== 2);
      expect(last.all).toBe(true);
    } finally { a.close(); b.close(); await srv.close(); }
  });
});

describe("parseArgs (server.cjs)", () => {
  const cwd = path.resolve("/work");
  it("folders resolve against the working folder; the Claude folder is the flag, else CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    expect(S.parseArgs(["a", path.resolve("/b")], {}, cwd)).toEqual({ folders: [path.join(cwd, "a"), path.resolve("/b")], port: null,
      claudeDir: path.join(os.homedir(), ".claude"), open: true, help: false });
    expect(S.parseArgs([], { CLAUDE_CONFIG_DIR: path.resolve("/env") }, cwd).claudeDir).toBe(path.resolve("/env"));
    expect(S.parseArgs(["--claude-dir", "c"], { CLAUDE_CONFIG_DIR: path.resolve("/env") }, cwd).claudeDir).toBe(path.join(cwd, "c"));
  });

  it("--port takes 0 to 65535, --no-open stops the browser, and an unknown flag or a missing value throws", () => {
    expect(S.parseArgs(["--port", "0", "--no-open"], {}, cwd)).toMatchObject({ port: 0, open: false, folders: [] });
    expect(S.parseArgs(["--port", "8123"], {}, cwd).port).toBe(8123);
    expect(() => S.parseArgs(["--port", "x"], {}, cwd)).toThrow("Not a port: x");
    expect(() => S.parseArgs(["--port", "70000"], {}, cwd)).toThrow("Not a port");
    expect(() => S.parseArgs(["--port"], {}, cwd)).toThrow("--port needs a value");
    expect(() => S.parseArgs(["--open"], {}, cwd)).toThrow("Unknown option: --open");
  });
});

describe("the browser stand-in, shared by server.cjs and scripts/demo.cjs", () => {
  const demo = require("../scripts/demo.cjs");
  const data = { workspace: { sessions: [] }, all: { sessions: [] }, details: {} };

  it("the demo writes its pages from the shared stand-in, in one theme each, with the webview's CSP", () => {
    const page = demo.demoPage("dark", data);
    expect(page).toContain(S.themeCss("dark"));
    expect(page).toContain("window.acquireVsCodeApi = () => api;");
    expect(page).not.toContain("prefers-color-scheme: dark) { html");
    expect(page).not.toContain("connect-src");
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-demo'; script-src 'nonce-demo';">`);
  });

  it("the server's page follows the system theme with both variable sets, and may connect to its own origin", () => {
    const page = S.browserPage({ theme: "auto", host: S.browserHost.toString(), connect: true, nonce: "n" });
    expect(page).toContain(S.themeCss("auto"));
    expect(S.themeCss("auto")).toContain("--vscode-sideBar-background: #f8f8f8;");
    expect(S.themeCss("auto")).toMatch(/@media \(prefers-color-scheme: dark\) \{ html \{ color-scheme: dark; [^}]*--vscode-sideBar-background: #181818;/);
    expect(page).toContain("connect-src 'self';");
  });

  it("a $ pattern in the host's source is kept as it is", () => {
    expect(S.browserPage({ theme: "light", host: "() => ({ x: \"$&$'\" })" })).toContain("x: \"$&$'\"");
  });
});
