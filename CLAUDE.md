# Claude Context

A VS Code panel that shows the context window of every live Claude Code session on the machine. What the
panel shows and why is in `README.md`; facts measured about Claude Code's files are in `NOTES.md`. Read
those instead of guessing, and keep this file to what neither says.

## The three files

No dependencies, no build step, and it stays that way: VS Code loads the folder as it is.

- `core.cjs`: pure functions and the two classes that touch the disk (`SessionReader`, `SessionWatcher`).
  No `vscode` import, so the tests can run all of it. Everything that can be computed belongs here.
- `extension.js`: the host. Reads the setting, owns the reader and the watcher, and talks to the webview
  with `postMessage` only (`ready`, `refresh`, `scope`, `detail` in; `sessions`, `detail` out).
- `panel.html`: the webview, one file with its CSS and script. It cannot read files. The CSP allows only
  nonce'd inline style and script, so no external resources. It has no automated tests, so keep logic
  that can be tested out of it.

## Commands

- `npm test`: Vitest over `test/core.test.js`. The same suite runs on Ubuntu and Windows in GitHub Actions.
- Try a change in VS Code: **Developer: Install Extension from Location…** on the repo folder once, then
  **Developer: Reload Window** after every change. Claude cannot judge the panel; the owner does.
- `/sak <n>` takes one issue through the workflow below. `/fakta` checks Claude Code's live files against
  what `core.cjs` reads; run it after Claude Code updates.

## Rules that are easy to break

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
