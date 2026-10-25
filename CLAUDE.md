# Claude Context

A VS Code panel, also served to a browser tab, that shows the context window of every live Claude Code session
on the machine. What the panel shows and why is in `README.md`; facts measured about Claude Code's files are in
`NOTES.md`. Read those instead of guessing, and keep this file to what neither says.

## The code

No dependencies, no build step, and it stays that way: VS Code loads the folder as it is, and Node runs the
server as it is. The code is in `src/`, one flat folder; the root keeps the docs and config, `package.json` among
them (its `main` and `bin` point into `src/`), so the repo folder is still what VS Code installs.

- `core.cjs`: pure functions and the two classes that touch the disk (`SessionReader`, `SessionWatcher`).
  No `vscode` import, so the tests can run all of it. Everything that can be computed belongs here, and what
  both hosts need (the Claude folder, the panel's page and CSP, the answers to its messages), so there is one
  copy.
- `extension.js`: the VS Code host. Reads the setting, owns the reader and the watcher (stopped while the view is
  hidden, replaced when the setting changes), and talks to the webview with `postMessage` only (`ready`,
  `refresh`, `scope`, `detail` in; `sessions`, `detail` out). Its tests hand it a stand-in for `vscode`.
- `server.cjs`: the browser host, with Node's `http` only. The same messages as `extension.js`, in as
  `POST /message` and out as Server-Sent Events on `/events`, and the same payloads. It also holds the browser
  stand-in for the webview (the `--vscode-*` theme variables and `acquireVsCodeApi`), which `scripts/demo.cjs`
  uses too, so there is one copy. Its rules: listen on `127.0.0.1` only, never `0.0.0.0`; every request carries
  the token made at start; refuse a `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` and a `POST`
  from another `Origin`; send no CORS headers. A new route keeps all four, with a test. Its page host,
  `browserHost`, runs in the browser but is tested in Node with stand-ins for what the browser gives it.
- `panel.html`, `panel.css`, `panel.js`: the webview's markup, style and script. `panelPage` joins them into one
  page for every load, the style and script inline in their nonce'd tags in place of the markers in `panel.html`,
  and puts the source of the core functions `panel.js` names with `/* core: <name> */` (`PANEL_FROM_CORE`) in
  place of each, so a rule both need has one copy. The page cannot read files. The CSP allows only nonce'd inline
  style and script (and, in the browser, `connect-src 'self'`), so nothing is loaded and no file is served on its
  own. It is tested in jsdom (`test/panel.test.js`) as a host loads it, fed lists from the real `buildSessions`;
  logic that can be computed still belongs in `core.cjs`. Its words fit both hosts.

## Commands

- `npm test`: Vitest over `test/`. The same suite runs on Ubuntu and Windows in GitHub Actions.
- Try a change in VS Code: **Developer: Install Extension from Location…** on the repo folder once, then
  **Developer: Reload Window** after every change. Claude cannot judge the panel; the owner does.
- Try it in a browser: `node src/server.cjs` (`--help` for the flags); stop it and start it again after a change.
- `node scripts/demo.cjs --shoot`: the README's screenshots in `media/`, from invented sessions read by the real
  `SessionReader`, with a headless Chrome. Run it after any change the user can see, or the images go stale; the
  owner judges them. Never take a README image from real sessions: their titles are the owner's conversations.
- `/issue <n>` takes one issue through the workflow below. `/facts` checks Claude Code's live files against
  what `core.cjs` reads; run it after Claude Code updates.

## Rules that are easy to break

- **Everything in the repo is English:** code, comments, docs, skill and command names, issues, commits
  and PRs, whatever language the conversation is in.
- **The registry and transcript formats are Claude Code's internal ones.** A missing field yields null
  ("unknown"), never an error. A new fact about the format is measured on real files and written in
  `NOTES.md` with the date and the Claude Code version, never assumed. Record field names and counts,
  not content: the transcripts hold the owner's conversations.
- **Windows is a first-class platform.** Tests build paths with `path.join`; paths from the registry can
  carry `\` and a lower-case drive letter (`NOTES.md`, "Windows").
- **Fixtures are hand-made** and anonymised (`test/fixtures/README.md`), one rule per transcript.
- **Comments say why**, with the measurement or source behind a constant, as the existing ones do.
- **README is prose** that says what the panel shows and why; a change the user can see updates it.

## Workflow

One issue at a time, each on its own branch, merged by the owner.

- Issues: `## Why`, `## What to build` (numbered), `## Tests`, and "Requested by the user on <date>."
- Branch: a short kebab-case topic (`scope-switch`, `vscode-only`), from an up-to-date `main`.
- Commit: `#<n> <one sentence on the result>`, a prose body wrapped at about 110 characters on what changed
  and why, ending with `Version 0.<x>.0.` when it was bumped.
- Version: bump the minor in `package.json` for every change the user can see; not for docs, tests or
  comments.
- PR: titled with the sentence and `(#<n>)`, body starting `Closes #<n>.` followed by bold-led bullets per
  area. Commit, push and open the PR only when asked; never merge.
