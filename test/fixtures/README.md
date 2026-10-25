# Test fixtures

`registry/` mimics Claude Code's `sessions/` folder: one JSON file per process. `7777.json` is truncated
on purpose (invalid JSON) and `not-a-registry.txt` is not a `.json` file; both must be skipped.
`1303.json` has the full shape a real entry had in Claude Code 2.1.301; the others carry only the fields
the core reads.

`transcripts/` are hand-made `.jsonl` transcripts in Claude Code's internal format, each exercising one
rule in `parseTranscript` (see the test names in `../core.test.js`).

`ttl-drop.jsonl` is three turns whose `cache_creation` goes 1-hour, then 5-minute, then nothing: the TTL
the core reports drops to 5m and stays there.

`sidechain-last.jsonl` mixes subagent entries (`isSidechain: true`) into the main transcript. Claude Code
2.1.259–2.1.310 writes them to a file of their own instead (`NOTES.md`, "Subagents and `isSidechain`"), so
the fixture tests the guard, not a shape seen on record.

`subagents/` is a project folder with one session, `bbbb-2`, in the layout of `NOTES.md`, "Subagents and
`isSidechain`": the main transcript `bbbb-2.jsonl` and `bbbb-2/subagents/agent-<agentId>.jsonl` with
`agent-<agentId>.meta.json`. The main transcript makes three Agent calls: `toolu_done`, whose result names
`a-done` as completed; `toolu_bg`, a background launch receipt for `a-running`, which is not an end; and
`toolu_cut`, whose result names no agent (a shape assumed, not seen), so `a-cut` ends by its call. A
`queue-operation` carries the task notification that ends `a-notified`. One rule per subagent:

- `a-done`: 212K, red, two turns, ended by the main transcript; its tokens are its own, not the session's 45K.
- `a-running`: no end recorded anywhere, so it runs while its file is newer than the process start.
- `a-cut`, `a-notified`: ended by the main transcript as above.
- `a-finished`: ended by `finished` in its meta file.
- `a-deep`: a subagent's subagent, `spawnDepth` 2 with `parentAgentId`.
- `a-badmeta`: a meta file that is not JSON; `a-oddmeta`: every field of the wrong kind; `a-nometa`: no meta file.
  All three give nulls.

`notes.txt` in `subagents/` is not a subagent and must be skipped.
