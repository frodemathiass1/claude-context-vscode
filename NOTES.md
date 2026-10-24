# Notes

Facts measured about Claude Code's files, each with the date and the Claude Code version it was seen on.
`/facts` surveys the live files against them.

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

## Session status (surveyed 2026-10-24, Claude Code 2.1.310, macOS)

`/facts` over the six registry entries and 40 transcripts of the last seven days, and the 2.1.310 bundle
(`~/.local/share/claude/versions/2.1.310`) read where it writes the registry:

- `status` values seen: `idle` 4, `busy` 1, `waiting` 1. The code sets exactly these three: `waiting` when a
  dialog, a question (elicitation), a worker request or a sandbox request waits for the user, in interactive
  mode; with `--output-format stream-json`, as the VS Code extension runs it, `running` becomes `busy`,
  `requires_action` `waiting` and `idle` `idle`. Claude Code's own agent list calls `waiting` "blocked". The 2.1.273
  bundle already has `waiting`; it is first seen here, not new.
- `waitingFor` is on the `waiting` entry only, a short label from a fixed set in the code: `permission prompt`,
  `input needed` (a question, or a dialog in stream-json), `dialog open`, `worker request`, `sandbox request` and
  `goal proposal`. The same literals are in 2.1.273 and 2.1.308.
- Registry fields on all six entries: those of the Windows section (`procStart`, `peerProtocol`, `peerFeatures`,
  `pidDomain`, `messagingSocketPath`, `nameSince`) are on macOS too, plus `bridgeSessionId` (a string).
- `message.usage` keys on all 3 667 assistant entries, beside the counters the core reads: `server_tool_use`,
  `service_tier`, `inference_geo`, `iterations`, `speed`, `output_tokens_details` (`thinking_tokens`), and
  `fallback_credit` on 3 436.
- `compactMetadata` (one auto compaction): `trigger`, `preTokens`, `postTokens`, `durationMs`,
  `cumulativeDroppedTokens`, `preCompactDiscoveredTools`, `preCompactArtifactReadVersions`, `preservedSegment`,
  `preservedMessages`.

So the core treats `waiting` as its own state (it was idle until 0.15.0, and folded into "Idle over an hour" after
a quiet hour) and any other value but `busy` as idle.

## Closed chat tabs (looked for a signal 2026-10-24, Claude Code 2.1.310, macOS)

The VS Code extension spawns one `claude` process per chat tab (`--output-format stream-json --input-format
stream-json`, a child of the extension host) and the process outlives its tab until "Developer: Reload Window"
or VS Code quits. Compared with the owner saying which tabs were open: one closed tab (closed after its last turn
at 15:19) against three open ones, all idle or busy in the same window. No signal tells them apart:

- **Registry and `claude agents --json`:** the same fields for both; `claude agents --json` lists `pid`, `cwd`,
  `kind`, `startedAt`, `sessionId`, `name` and `status` only. Nothing is written to the registry on close
  (`updatedAt` equals `statusUpdatedAt`, the last status change). Each process also has a
  `<pid>.<hash>.key` file in `sessions/`, written at start.
- **Transcript:** nothing on close; the closed tab's file ends with the last turn's `stop_hook_summary`, as the
  open ones do.
- **Stdio:** the extension host holds the other end of stdin, stdout and stderr for every process, closed tab or
  not. The extension's `closeChannel` ends the channel's input stream when a tab closes, but `lsof` on macOS does
  not show whether a unix socket is half-closed, and the process does not exit.
- **`messagingSocketPath`:** every process keeps listening on its socket.
- **The extension's log** (`~/Library/Application Support/Code/logs/<start>/window<n>/exthost/Anthropic.claude-code/`)
  wrote "Closing Claude on channel: <id>" in the logs up to 2026-10-22, but not once on 2026-10-24 although a tab
  was closed, and the line names a channel, not a pid. Internal, VS Code-only, and not reliable.

A tab VS Code restores after a reload has no process until it is opened; opening it on an old session spawns a
new process (`resume:` in the log) whose registry `startedAt` is the new start, while the last turn is old.

So the panel cannot know which tab is open. It folds a session that is not busy and had neither a turn nor its
process start for an hour (`DIM_AFTER_MS`, the longer cache TTL) into "Idle over an hour", and counts them in the
header; an empty session goes there by its start alone. Some of those are open tabs left alone, which is why the
group is not called closed. Ending such a process from the panel is a separate question (destructive: it could
end an open tab).
