# Test fixtures

`registry/` mimics Claude Code's `sessions/` folder: one JSON file per process. `7777.json` is truncated
on purpose (invalid JSON) and `not-a-registry.txt` is not a `.json` file; both must be skipped.
`1303.json` has the full shape a real entry had in Claude Code 2.1.301; the others carry only the fields
the core reads.

`transcripts/` are hand-made `.jsonl` transcripts in Claude Code's internal format, each exercising one
rule in `parseTranscript` (see the test names in `../core.test.js`).

`ttl-drop.jsonl` is three turns whose `cache_creation` goes 1-hour, then 5-minute, then nothing: the TTL
the core reports drops to 5m and stays there.
