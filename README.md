# Claude Context

A VS Code panel that shows the context window of every live Claude Code session on the machine, updated
in real time. The header has the count and a zone meter (how many sessions are green, below 100K tokens;
yellow, up to 150K; red, above). The sessions sit under "Working now" and "Idle", one row each: title, a
context bar scaled 0–200K with marks at 100K and 150K, a sparkline of tokens per turn with a marker at
every compaction or `/clear`, the count in the zone colour, and the model, the number of turns and the
time since the last turn. Busy sessions pulse and sort first; sessions idle for more than an hour are
dimmed. The rows stack in the narrow sidebar and spread over four columns when the panel is 620 px or
wider. "All projects" lists the whole machine grouped by project; the default is the sessions inside the
window's workspace folders.

No dependencies, no build step: `extension.js` (the host), `core.cjs` (pure functions) and `panel.html`
(the webview).

## Requirements

- VS Code 1.131 or newer.
- Claude Code running on the same machine (any backend: Anthropic, Amazon Bedrock, Vertex AI). The
  panel reads Claude Code's own files; it never calls an API.

## Install

The extension is not on the Marketplace; VS Code loads it straight from a cloned folder. All commands
below are run from the Command Palette: Ctrl+Shift+P (Cmd+Shift+P on macOS), type the command name and
press Enter.

1. Clone the repo to a folder that stays put (VS Code loads the extension from it on every start):

   ```
   git clone https://github.com/frodemathiass1/claude-context-vscode
   ```

   For example `C:\Develop\claude-context-vscode` on Windows or `~/Dev/claude-context-vscode` on macOS.
2. Command Palette → **Developer: Install Extension from Location…** → pick the cloned folder (the one
   with `package.json` in it).
3. Command Palette → **Developer: Reload Window**.

## Open the panel

- Click the **Claude Context** icon (a clock) in the activity bar, the vertical icon bar on the far left.
  With many icons it may sit behind **…** at the end of the bar; right-click the bar to choose which icons
  it shows.
- Or: Command Palette → **Claude Context: Focus on Claude sessions View** (type `Claude sessions`). **View: Open View…**
  followed by `Claude sessions` does the same.

If neither the icon nor the command shows up, the window was not reloaded after the install: run
**Developer: Reload Window**. **Extensions: Show Installed Extensions** should list "Claude Context".

To keep the panel visible next to the file explorer or the Claude Code chat, drag the icon to the other
side of the window, or right-click it → **Move To** → **Secondary Side Bar**.

The panel lists the sessions started inside the window's workspace folders. Tick **All projects** to
see every live session on the machine, grouped by project.

## Update and uninstall

- Update: `git pull` in the clone, then **Developer: Reload Window**.
- Uninstall: **Extensions: Show Installed Extensions** → Claude Context → **Uninstall**, then delete the
  clone.

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
