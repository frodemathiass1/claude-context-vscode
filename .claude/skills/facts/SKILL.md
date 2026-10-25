---
name: facts
description: Check Claude Code's live registry and transcripts on this machine against what src/core.cjs reads and what NOTES.md records, after a Claude Code update or when the panel shows "unknown". Use when the user says "/facts", asks whether a new Claude Code version changed the format, or a row shows unknown values.
---

# Facts

## Claude Code on this machine

!`claude --version`

## Survey

!`node .claude/skills/facts/scripts/survey.cjs`

The survey prints field names, enumerations and counts only. Pass a folder, `--days <n>` or `--max <n>`
to look elsewhere or wider (`node .claude/skills/facts/scripts/survey.cjs --days 30 --max 200`).

## Task

Compare the survey with `NOTES.md` and `src/core.cjs`, and report in a few lines:

1. **What core reads and now misses.** Every line marked `<-- check`, any null in the "CORE" section, and
   models that `modelShort` shows raw. These are the findings that matter: say which panel value goes
   unknown or wrong because of each.
2. **What is new.** Registry fields, `status` values, entry types, usage keys or compaction fields that
   `NOTES.md` does not mention. New fields are not a problem by themselves; say whether any looks like a
   replacement for one core reads.
3. **What NOTES.md says that no longer holds.**

Then, when something changed, propose the edit to `NOTES.md` (a dated section with the Claude Code
version, in its style: what was seen, how it was counted) and, if core needs a change, an issue in the
repo's format. Ask before writing either. Never copy content from a transcript into the repo: titles,
messages and paths stay on this machine.
