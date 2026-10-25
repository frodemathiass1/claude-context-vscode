# Claude Context

A VS Code panel, also served to a browser tab, that shows the context window of every live Claude Code session
on the machine. Before changing what the panel shows, read `README.md`; before relying on a field of Claude
Code's files, read `NOTES.md`. This file holds what neither says.

## The code

No runtime dependencies, no build step, and it stays that way: VS Code loads the repo folder as it is, and Node
runs the server as it is. The code is in `src/`, one flat folder; the root holds the docs and config, so the
repo folder is what VS Code installs.

A rule that both hosts, or the core and the panel, need has **one copy**.

- `core.cjs`: pure functions and the two classes that touch the disk (`SessionReader`, `SessionWatcher`). It
  imports nothing from `vscode`, so the tests run all of it. Everything that can be computed lives here, with
  what both hosts share: the Claude folder, the panel's page and CSP, and the answers to the panel's messages.
- `extension.js`: the VS Code host. It owns the reader and the watcher (stopped while the view is hidden,
  replaced when the setting changes) and talks to the webview through `postMessage` alone (`ready`, `refresh`,
  `scope`, `detail` in; `sessions`, `detail` out). Its tests hand it a stand-in for `vscode`.
- `server.cjs`: the browser host, on Node's `http` alone, with the same messages and payloads as `extension.js`:
  in as `POST /message`, out as Server-Sent Events on `/events`. It holds the browser's stand-in for the webview
  (the `--vscode-*` theme variables and `acquireVsCodeApi`), shared with `scripts/demo.cjs`. Four guards: it
  listens on `127.0.0.1` only; every request carries the token made at start; it accepts only a `Host` of
  `127.0.0.1:<port>` or `localhost:<port>`, and a `POST` only from its own `Origin`; it sends no CORS headers.
  A new route keeps all four, with a test. Its page host, `browserHost`, runs in the browser and is tested in Node
  with stand-ins for what the browser gives it.
- `panel.html`, `panel.css`, `panel.js`: the webview's markup, style and script, joined by `panelPage` into one
  page on every load. `panel.js` gets the source of a core function listed in `PANEL_FROM_CORE` by writing
  `/* core: <name> */`. The page cannot read files, and the CSP allows only nonce'd inline style and script
  (in the browser also `connect-src 'self'`), so nothing is loaded and no file is served on its own. The panel
  only draws; what can be computed belongs in `core.cjs`. Tested in jsdom (`test/panel.test.js`) as a host
  loads it, fed lists from the real `buildSessions`. Its words fit both hosts.

## Commands

- `npm test`: green before every commit.
- Try a change in VS Code: **Developer: Install Extension from Location…** on the repo folder once, then
  **Developer: Reload Window** after every change. Claude cannot judge the panel; the owner does.
- Try it in a browser: `node src/server.cjs` (`--help` for the flags); stop it and start it again after a change.
- `node scripts/demo.cjs --shoot`: the README's screenshots in `media/`, from invented sessions read by the real
  `SessionReader`, with a headless Chrome. Run it after any change the user can see, or the images go stale; the
  owner judges them. Only invented sessions go in an image: real titles are the owner's conversations.
- `/issue <n>` takes one issue through the workflow below. `/facts` checks Claude Code's live files against
  what `core.cjs` reads; run it after Claude Code updates.

## Rules that are easy to break

- **Everything in the repo is English:** code, comments, docs, skill and command names, issues, commits
  and PRs, whatever language the conversation is in.
- **The registry and transcript formats are Claude Code's internal ones.** A missing field yields null
  ("unknown"), never an error. A new fact about the format is measured on real files and written in
  `NOTES.md` with the date and the Claude Code version. Record field names and counts, not content: the
  transcripts hold the owner's conversations.
- **Windows is a first-class platform**, and CI runs the tests there. Tests build paths with `path.join`;
  paths from the registry can carry `\` and a lower-case drive letter (`NOTES.md`, "Windows").
- **Fixtures are hand-made** and anonymised (`test/fixtures/README.md`), one rule per transcript.
- **Comments say why**, with the measurement or source behind a constant, as the existing ones do.
- **README is prose** that says what the panel shows and why; a change the user can see updates it.

## Workflow

One issue at a time, each on its own branch; the owner merges.

- Issues: `## Why`, `## What to build` (numbered), `## Tests`, and "Requested by the user on <date>."
- Branch: a short kebab-case topic (`scope-switch`, `vscode-only`), from an up-to-date `main`. Uncommitted
  changes in the folder may be another session's work: leave them on their branch, and stop and ask or work in
  a worktree.
- Commit: `#<n> <one sentence on the result>`, a prose body wrapped at about 110 characters on what changed
  and why, ending with `Version 0.<x>.0.` when it was bumped.
- Version: bump the minor in `package.json` for every change the user can see; not for docs, tests or
  comments.
- PR: titled with the sentence and `(#<n>)`, body starting `Closes #<n>.` followed by bold-led bullets per
  area. Commit, push and open the PR only when the owner asks (running `/issue` is asking).
- Review: once the PR is open, a read-only subagent reviews and verifies it, briefed with the issue and the diff,
  not with conclusions. Confirmed defects are fixed on the same branch before the work is called done.
- After a merge: switch to `main` and pull, delete the branch locally and on GitHub (`git branch -d`,
  `git push origin --delete`), then `git fetch --prune`, without asking.
