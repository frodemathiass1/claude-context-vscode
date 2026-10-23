# Notes

Facts found along the way. `PLAN.md` says which step each section belongs to.

## Sources (2026-10-22)

Claude Code docs at code.claude.com/docs: `claude-directory` ("Application data", "Cleaned up
automatically"), `sessions` ("Where transcripts are stored"), `env-vars` (`CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_PROJECT_DIR_NAME`), `agent-view` ("List sessions as JSON"), `amazon-bedrock`, `setup` ("Set up
on Windows"), `changelog` (2.1.152, 2.1.234, 2.1.246).

## Registry entry seen on macOS (Claude Code 2.1.301)

```json
{"pid":1303,"sessionId":"aaaa-1","cwd":"/Users/frode/Dev/my-project","startedAt":1792603960396,"version":"2.1.301","kind":"interactive","entrypoint":"claude-vscode","name":"my-project-08","nameSource":"derived","updatedAt":1792603961075,"status":"busy","statusUpdatedAt":1792603961075}
```

## Windows (seen 2026-10-22, Windows 11)

- Versions (step 0): VS Code 1.141.2, git 2.56.0.windows.2, Node 26.12.1, Claude Code 2.1.304. `npm test`
  was green (34 tests) on the fresh clone before any change.
- Registry fields and the form of `cwd`: the same fields as on macOS plus `procStart`, `peerProtocol`,
  `peerFeatures`, `pidDomain` (`win32:<host>`), `messagingSocketPath` (a named pipe) and `nameSince`. `cwd`
  is a Windows path with `\` and the drive letter as VS Code gave it: `c:\Develop\my-project` (lower case)
  for sessions started in the VS Code extension, `C:\…` for others (worktrees).
- `status` values seen: `busy`, `idle`.
- Project folder name and the rule it follows: the documented rule holds. `c:\Develop\my-project` gives
  `c--Develop-my-project`, and `C:\Develop\my-project\.claude\worktrees\x` gives
  `C--Develop-my-project--claude-worktrees-x`. The drive letter keeps its case, so both `c--…` and `C--…`
  folders exist side by side; the file system is case-insensitive, so the lookup finds either.
- Environment variables VS Code sees: `CLAUDE_CONFIG_DIR` unset (the folder is `%USERPROFILE%\.claude`),
  `CLAUDE_CODE_USE_BEDROCK=1`.

## Bedrock (seen 2026-10-22, Claude Code 2.1.304)

- `message.model` in an assistant entry: `claude-opus-5-5`, the same as on the Anthropic API (no
  `us.anthropic.` or `eu.anthropic.` prefix, although the configured model id has one).
- `message.usage`: the flat fields `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
  are present, and `cache_creation` is nested next to them with `ephemeral_1h_input_tokens` and
  `ephemeral_5m_input_tokens` (the sum equals the flat field). Prompt caching works in the region.
- `message.id` and `isSidechain` present: yes, both (`message.id` starts with `msg_bdrk_`).

So step 4 of the plan needs no code change: the core already reads Bedrock transcripts correctly.

## The prompt cache in the transcript (seen 2026-10-22, Claude Code 2.1.301–2.1.304)

Every assistant entry's `message.usage` has `cache_creation` with both `ephemeral_1h_input_tokens` and
`ephemeral_5m_input_tokens` (in either order), next to the flat `cache_creation_input_tokens`, which equals
their sum. Across the transcripts on this machine a turn writes under one TTL only: the 1-hour one as a
rule, the 5-minute one on usage overage (seen as `ephemeral_1h_input_tokens: 0` with 29K and 276K under 5m).
Both above zero in one turn was never seen; the core then reports 5m, the part that goes cold first. The
prices (platform.claude.com/docs/en/docs/build-with-claude/prompt-caching, read 2026-10-22) are in a
comment in `core.cjs`; the panel shows no cost, only the state. The cache is refreshed on every use, so
the deadline is the last turn plus the TTL, per session.

## Where the context grows (measured 2026-10-23, 319 transcripts, 13 149 gaps between turns)

The facts behind `baseline` and `growthBySource`, measured in the owner's transcripts (Opus 5, Opus 5.5,
Fable 5.1):

- A `/clear` always starts a new transcript (116 of 116: the command is the first line of a new file), so
  a segment starts at the start of a file or at a `compact_boundary`.
- The input counters are equal on every block of a response (15 591 of 15 591 blocks with the same
  `message.id`), like the output counters.
- Earlier thinking stays in the context. In 610 turns where the previous turn thought at least 500 tokens
  and almost nothing entered after it, the context grew by the previous turn's whole `output_tokens`
  plus about 10 % (median 1.10, p10 1.03); if thinking were dropped it would grow by output minus
  thinking. Turns without thinking give the same 1.10, so the 10 % is framing and reminders. The
  "output" share is therefore not overstated.
- Tool results cost about the same per character: Bash 2.04 characters per token (1 197 gaps, p25–p75
  1.97–2.12), Read 2.04 (79 gaps). Rarer tools run higher, Skill 2.55, Agent 2.58, WebSearch 2.62, so
  they are overstated by 25–50 % when they share a gap with Bash or Read. 65 % of the growth is in gaps
  with one dominant source, where nothing is split.
- One image grows the context by a median 1 643 tokens (113 gaps), but from about 600 to 3 800 (p10–p90),
  so the fixed weight (`IMAGE_CHARS`) is rough per image; it matters only when an image shares a gap
  with other input.
- Attachments enter the context only when they have `rendered` (the text sent to the model); the rest
  (`deferred_tools_record`, `prompt_snapshot`, `batching_reminder_sent` and others) are bookkeeping.
- The context fell between two turns once in 13 149 gaps.

## Hosting the panel outside VS Code

`panel.html` has a second adapter for when `acquireVsCodeApi` does not exist: it fetches
`/claude-context/api/sessions` once (JSON in the shape `SessionReader.read()` returns, or `{ "error": "…" }`
with a non-2xx status) and then listens to server-sent events on `/claude-context/api/stream`, where
every event is named `sessions` and carries the same JSON. A host that wants the panel in a browser
serves the file and those two routes with `core.cjs`.

The panel's colours and fonts are the `--kx-*` variables at the top of `panel.html`, each defaulting to a
`--vscode-*` variable with a plain fallback. A host sets them from its own tokens in a style appended to
head. The set since the gauges redesign (2026-10-22): `--kx-bg`, `--kx-fg`, `--kx-muted`, `--kx-border`,
`--kx-border-strong`, `--kx-row-hover`, `--kx-accent`, `--kx-font`, `--kx-font-size`, `--kx-mono`,
`--kx-heading`, `--kx-badge-bg`, `--kx-badge-fg`, `--kx-grid`, `--kx-track`, `--kx-blue`, and per zone the
pair `--kx-<zone>` (text: the count and the legend numbers) and `--kx-<zone>-fill` (fills: the dot, the
context bar, the curve and the meter segments), for `green`, `yellow`, `orange` (since the four zones,
2026-10-22) and `red`. Orange is mixed halfway between the theme's yellow and red, not read from
`--vscode-charts-orange`: VS Code derives that one from `editor.findMatchHighlightBackground` (`#EA5C0055`),
a third-opaque orange that read brown over the dark side bar (Frode, 2026-10-22). The zone list, the limits (100K, 125K and 150K) and the
scale (200K) are three constants at the top of the panel's script; a new zone is one entry there, one
limit and one colour pair, and `core.cjs` decides the zone (`zone()`, `zoneCounts`).

The prompt-cache state uses the same variables: the countdown turns `--kx-orange` a few minutes before
the deadline, the 5m pill is `--kx-orange` too, and the pill's border is `--kx-border-strong`; no new
variable since 0.5.0. The payload has `cacheCounts` (`warm`, `cold`) beside `zoneCounts`, and per session
`cacheTtlMs`, `cacheRead`, `cacheCreated`, `hitShare`, `coldAt`, `coldInMs` and `cacheState`; a host that
builds a payload by hand (an error reserve) should include `cacheCounts`, although the panel shows 0 / 0
without it.

The panel keeps `<header>` and `<main>` as its two top-level blocks (plus the two hidden message blocks
with `data-testid="contact"` and `data-testid="errors"`), so a host can size and centre them.
