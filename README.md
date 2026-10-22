# Claude Context

A VS Code panel that shows the context window of every live Claude Code session on the machine, updated
in real time: title, model, tokens in the context, a colour zone (green below 100K, yellow up to 150K,
red above), a sparkline of tokens per turn with a marker at every compaction or `/clear`, the number of
turns and the time since the last turn. Sessions that are busy pulse and sort first; sessions idle for
more than an hour are dimmed. "All projects" lists the whole machine grouped by project; the default is
the sessions inside the window's workspace folders.

No dependencies, no build step: `extension.js` (the host), `core.cjs` (pure functions) and `panel.html`
(the webview).

## Requirements

- VS Code 1.131 or newer.
- Claude Code running on the same machine (any backend: Anthropic, Amazon Bedrock, Vertex AI). The
  panel reads Claude Code's own files; it never calls an API.

## Install

1. `git clone https://github.com/frodemathiass1/claude-context-vscode`
2. In VS Code: Ctrl+Shift+P (Cmd+Shift+P on macOS) → **Developer: Install Extension from Location…** →
   pick the cloned folder.
3. **Developer: Reload Window**. The "Claude Context" icon appears in the activity bar.

To update: `git pull` in the clone, then **Developer: Reload Window**.

## Settings

- `claudeContext.claudeDir`: the folder Claude Code stores its data in. Empty (the default) means
  `CLAUDE_CONFIG_DIR`, else `~/.claude`. Set it when the panel says "Registry folder not found", for example
  because `CLAUDE_CONFIG_DIR` is set in your shell profile but VS Code was started without it. Reload the
  window after changing it.

## Windows and Amazon Bedrock

Both work without configuration (checked on Windows 11 with Claude Code 2.1.304 on Bedrock). Sessions in a
subfolder of the workspace, such as git worktrees under `.claude\worktrees\`, count as the window's and are
named after their own folder. Bedrock transcripts carry the same model names and token fields as the
Anthropic API.

## Privacy

The title of a session is its AI-generated title or, before there is one, the start of its first message.
The panel only shows it locally, but it can contain whatever was typed, so keep that in mind when sharing
your screen.

## How it works

Claude Code keeps one small file per running process in `~/.claude/sessions/` and the transcript of
every session in `~/.claude/projects/<project>/<sessionId>.jsonl` (`~/.claude` is `%USERPROFILE%\.claude`
on Windows; `CLAUDE_CONFIG_DIR` moves it). The extension joins the two, parses only the new bytes of a
transcript on every change (`fs.watch` on the folders, debounced, plus a 30-second tick) and pushes the
list to the webview.

The transcript format is Claude Code's internal one and can change between versions. A field the panel
cannot find shows as "unknown"; nothing throws.

## Development

```
npm install
npm test        # Vitest; the same suite runs on Ubuntu and Windows in GitHub Actions
```

`PLAN.md` is the work plan for the Windows and Amazon Bedrock support; `NOTES.md` holds the facts found
along the way.

## License

MIT, see `LICENSE`.
