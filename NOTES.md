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

The panel keeps `<header>` and `<main>` as its two top-level blocks (plus the two hidden message blocks
with `data-testid="contact"` and `data-testid="errors"`), so a host can size and centre them.
