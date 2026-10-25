---
name: issue
description: Take one GitHub issue of this repo end to end — read it, branch, build, test, update README/NOTES and the version, commit, open the PR and have it reviewed. Use when the user says "/issue 32" or asks to work on an issue by number.
argument-hint: <issue number>
---

# Issue $ARGUMENTS

## The issue

!`gh issue view $ARGUMENTS --comments`

## State

!`git status --short --branch && git log --oneline -3`

## Steps

Follow the rules and the workflow in `CLAUDE.md`. In order:

1. **Read the issue to the end, comments included.** Done when you can say what each numbered item builds and
   what each test checks. If building waits for something (a sketch, a decision, a comment from the owner)
   that has not arrived, stop and say what is missing; if something is unclear, ask before writing code.
2. **Branch** as `CLAUDE.md`'s Workflow says (`git switch main && git pull` first). Done when `git status`
   shows the new branch, clean, at `origin/main`.
3. **Build** by the rules in `CLAUDE.md`. Done when every fact about Claude Code's files that the issue
   relies on is measured on real files (`/facts` or a targeted look) and written in `NOTES.md`.
4. **Test.** Done when every rule added to `src/core.cjs` has a test in `test/core.test.js` (a new hand-made
   fixture for a new transcript shape) and `npm test` is green, its summary line shown.
5. **Docs and version.** Done when `README.md` covers every change the user can see, `NOTES.md` every
   measurement, and the minor version in `package.json` is bumped if the change is visible.
6. **Hand over.** Commit as `#$ARGUMENTS <sentence>` with a prose body, push, and open the PR with
   `Closes #$ARGUMENTS.` (formats in `CLAUDE.md`); the owner merges. Done when the PR's link is shown.
7. **Review.** A read-only subagent reviews the PR (`CLAUDE.md`, Workflow). Done when every defect it confirms
   is fixed and pushed on the same branch, and your last message gives its findings and what the owner should
   look at in VS Code (**Developer: Reload Window** first): the rows, states and widths the change touches, in
   light and dark theme.
