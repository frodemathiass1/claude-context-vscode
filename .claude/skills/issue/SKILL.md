---
name: issue
description: Take one GitHub issue of this repo end to end — read it, branch, build, test, update README/NOTES and the version, commit and open the PR. Use when the user says "/issue 32" or asks to work on an issue by number.
argument-hint: <issue number>
---

# Issue $ARGUMENTS

## The issue

!`gh issue view $ARGUMENTS --comments`

## State

!`git status --short --branch && git log --oneline -3`

## Steps

Follow the rules and the workflow in `CLAUDE.md`. In order:

1. **Read the issue to the end, comments included.** If it says that building waits for something (a
   sketch, a decision, a comment from the owner) and that has not arrived, stop and say what is missing.
   If something is unclear, ask before writing code, not after.
2. **Branch** from an up-to-date `main` (`git switch main && git pull`), named after the topic in a few
   kebab-case words. If the working tree is not clean, stop and ask.
3. **Build.** Logic that can be computed goes in `core.cjs`; `panel.html` only draws. A fact about
   Claude Code's files that the issue relies on is checked on real files first (`/facts` or a targeted
   look, names and counts only) and written in `NOTES.md`.
4. **Test.** Every rule added to `core.cjs` gets a test in `test/core.test.js`, with a new hand-made
   fixture when a transcript shape is new. `npm test` must be green; show the summary line.
5. **Docs and version.** Update `README.md` for anything the user can see, `NOTES.md` for anything
   measured, and bump the minor version in `package.json` when the change is visible.
6. **Hand over.** Commit as `#$ARGUMENTS <sentence>` with a prose body, push, and open the PR with
   `Closes #$ARGUMENTS.` (formats in `CLAUDE.md`). Do not merge. End with what the owner should look at
   in VS Code (**Developer: Reload Window** first): the rows, states and widths the change touches, in
   light and dark theme.
