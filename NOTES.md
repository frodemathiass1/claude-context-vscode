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

## Windows (step 2 of the plan: fill in)

- Versions (step 0):
- Registry fields and the form of `cwd`:
- `status` values seen:
- Project folder name for the clone, and the rule it follows:
- Environment variables VS Code sees (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`):

## Bedrock (step 2 of the plan: fill in)

- `message.model` in an assistant entry:
- `message.usage` (flat fields and any nested `cache_creation`):
- `message.id` and `isSidechain` present:

## Hosting the panel outside VS Code

`panel.html` has a second adapter for when `acquireVsCodeApi` does not exist: it fetches
`/claude-context/api/sessions` once (JSON in the shape `SessionReader.read()` returns, or `{ "error": "…" }`
with a non-2xx status) and then listens to server-sent events on `/claude-context/api/stream`, where
every event is named `sessions` and carries the same JSON. A host that wants the panel in a browser
serves the file and those two routes with `core.cjs`.
