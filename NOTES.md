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
{"pid":1303,"sessionId":"aaaa-1","cwd":"/Users/me/Dev/my-project","startedAt":1792603960396,"version":"2.1.301","kind":"interactive","entrypoint":"claude-vscode","name":"my-project-08","nameSource":"derived","updatedAt":1792603961075,"status":"busy","statusUpdatedAt":1792603961075}
```

## Windows (seen 2026-10-22, Windows 11)

- Versions: VS Code 1.141.2, git 2.56.0.windows.2, Node 26.12.1, Claude Code 2.1.304. `npm test`
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

So the core reads Bedrock transcripts without a code change.

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

## Subagents and `isSidechain` (measured 2026-10-25, Claude Code 2.1.259–2.1.310, macOS)

- **The main transcript** (`<sessionId>.jsonl`): 413 files from 2026-09-10 to 2026-10-25, not one entry with
  `isSidechain: true`. Every message entry carries `isSidechain: false`; the entries without the field are
  bookkeeping (`ai-title`, `api-request`, `api-request-blob`, `queue-operation`, `last-prompt`,
  `bridge-session`, `file-history-snapshot` and the like), none with `usage`.
- **A subagent's transcript** is its own file, `<sessionId>/subagents/agent-<agentId>.jsonl` (279 files under 197
  sessions). Every message entry carries `isSidechain: true`, the parent's `sessionId` and an `agentId`; only
  the `api-request*` entries lack the field. Its assistant entries have the same `message.usage` as the main
  session's: a subagent has a context window of its own. Its last turn (input, cache read and cache creation)
  over the 280 files: from 3.6K to 426K tokens, median 72K, 90th percentile 151K; 29 above 150K, 18 above 200K.
- **Next to it, `agent-<agentId>.meta.json`**, with the fields on how many of the 279 files: `agentType` 279,
  `requestShape` 279, `requestNonInteractive` 279, `spawnDepth` 274 (1, or 2 for a subagent's subagent, which
  then has `parentAgentId`, 4), `description` 88, `toolUseId` 88, `isBuiltIn` 52, `finished` 26,
  `launchedWithDefaults` 19, `spawnMode` 13, `model` 1. `finished` is only ever `true`; it is first seen in
  2.1.301, and from then on 26 of 103 files have it (11 of 42 in 2.1.310), so a file without it is not known to
  be running.

So a session's count comes from `<sessionId>.jsonl` only and never includes a subagent's tokens, which is right:
what a subagent adds to the main context is its report, a `tool_result` of the Agent call, which `growthBySource`
counts under "Agent". The sidechain filter in `parseTranscript` is a guard: no main transcript on this machine
mixes sidechain entries in. The subagents' own files are read beside it, each with its own count (#66).

## When a subagent ends (measured 2026-10-25, Claude Code 2.1.310, macOS)

Over the 285 subagents on this machine (meta files from 2.1.259 to 2.1.310), and two background Agent calls
watched live in 2.1.310:

- **`finished` in the meta file** is written when the subagent's loop ends, by foreground and background calls
  alike: 29 of the 30 Agent calls since 2.1.301 have it; the 30th (2.1.301, last written 2026-10-21) has no end
  recorded anywhere and was cut off with its process. On record, all 7 foreground calls since 2.1.301 have it
  (this harness starts every Agent call in the background, so no foreground one was watched). The two live calls
  had no `finished` while they ran and got it when they ended, the meta file rewritten in the same second as the
  last entry. Forks (a forked slash command or skill: its result's `toolUseResult` has `commandName`) never write
  it: 0 of 79. A stopped call writes it too (1 on record, with a `stopped` notification).
- **The main transcript records the end** of 279 of the 285: an Agent `tool_result` whose `toolUseResult` names
  the subagent (`agentId`) with `status` `completed` (23, a foreground call's report) or `forked` (189, a fork's
  result, written after the fork's last entry); or a `<task-notification>` whose `<task-id>` is the agent id, in a
  `queue-operation` entry's `content`, sometimes also in a user entry (background calls; `<status>` over all task
  notifications, background shell commands included: `completed` 722, `failed` 51, `killed` 13, `stopped` 10).
  A background call's own `tool_result` is a receipt, `toolUseResult.status` `async_launched` (65), not its end.
  The 6 without a record are 5 from 2.1.282 and the one from 2.1.301 above, none written for days.
- **A background call that ends with work of its own still running** (a shell command it started in the
  background) gets `finished: true` and a `completed` notification at once, and the notice says it may resume
  when that work reports. It did, 14 minutes later: a user entry woke it, it wrote three entries in two seconds
  (ending with its `SubagentHandback` call), and a second `completed` notification followed. `finished` stayed in
  its meta file the whole time, so the core shows such a subagent as finished while it runs again.
- **The subagent's own transcript does not mark its end:** 22 of the 29 with `finished` end with a user entry (a
  tool result, such as the `SubagentHandback` call a subagent ends with in 2.1.310, or a stop mid-tool), and
  `api-request` entries follow the last turn; the meta file was written before the transcript's last write in 20
  of the 29.
- **Meta fields seen now** beside those above: `model` on a call that names one, as an alias (`haiku`).

So the core calls a subagent "finished" when `finished` is in its meta file or the main transcript records its
end (the agent id from a result or a task notification, or the Agent call's id from a `tool_result` that is not a
launch receipt), "running" when neither does and its transcript was written since the session's process started
(a subagent runs inside that process), and "unknown" otherwise.
