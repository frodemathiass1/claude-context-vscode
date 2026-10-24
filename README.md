# Claude Context

A VS Code panel that shows the context window of every live Claude Code session on the machine, updated
in real time. The header has the count and a zone meter (how many sessions are green, below 100K tokens;
yellow, below 125K; orange, up to 150K; red, above). The zones are absolute token counts, not a share of
the model's window: they follow Matt Pocock's smart zone and dumb zone, where the dumb zone "commonly
begins around 125K-150K tokens". The sessions sit under "Working now" and "Idle", one row each: title, a
context bar scaled 0–200K with marks at 100K, 125K and 150K (its tooltip says what to do at the next phase
boundary in the yellow, orange and red zones), whose first part, in a muted shade, is the start of the session:
the first turn, which holds the fixed load (CLAUDE.md, memory, skill and tool listings) and the first message
("start 29K · conversation 87K"; after a compaction it starts again at the first turn after it), with an
estimate under it of where the conversation's growth went ("≈ Bash 50K · output 46K · Read 27K": per turn,
what the model wrote first, the rest split by length over the tool results, your messages and attachments;
every source in the tooltip), a sparkline of tokens per turn with a solid
mark at every compaction Claude Code recorded (the tooltip says whether it was automatic and the count
before and after) and a dotted one at any other sharp drop (a `/clear` starts a new transcript, so it
starts a new curve), thin bars under it with the output tokens per turn (the thinking part drawn stronger), the count in the zone colour, and the model with the effort of the last turn ("Opus 5.5 · xhigh"), the number of turns, the output tokens of the session ("44K out"; the tooltip has the last turn and the thinking share) and the
time since the last turn, and the prompt cache: "warm · 47 min" counts down to the moment the cache goes
cold (the last turn plus the TTL Claude Code chose, shown as a 1h or 5m pill; a drop to 5m is marked), a
few minutes before that the text turns orange, and afterwards it says "cold". The tooltip has the deadline,
how much of the last turn's context was read from cache and how much was written. The header counts the
warm and cold sessions beside the zone meter, and the median start of the sessions that began fresh, so
a CLAUDE.md that grew shows at a glance. Busy sessions pulse and sort first; sessions idle for more
than an hour are dimmed. The rows stack in the narrow sidebar and spread over four columns when the panel is 620 px or
wider. "All projects" lists the whole machine grouped by project; the default is the sessions inside the
window's workspace folders. Every group heading ("Working now", "Idle", a project) folds and unfolds on a
click, keeping its count; the panel remembers which are folded. The refresh button at the end of the header
reads the registry and every transcript again from the first byte, and says "updated 12:04:31" when done.
A control row under the header sorts the rows inside each group (last turn, context size, time until cold,
started, title; rows without a value go last) and filters the idle group: hide the dimmed sessions, show
only the orange and red zones, switch a model off with its chip. A busy session is never hidden; the header
keeps counting everything and says "showing 4 of 10" while a filter is on, a group heading says "4 of 9",
and "reset" puts the view back. The view is remembered like the folds. Click a row (or press Enter on it) to open the
session's detail view in its place: the title, project, model and effort, turns, start and last turn; one
sentence of facts ("Red zone after 1 compaction; this segment started at 169K, a fresh session here typically
starts at ~29K", the last part from the header's start median, no advice); a large curve of tokens per turn over
the whole session with the four zone bands, every compaction labelled with its trigger and counts, and the
segment's start; hovering a turn, or moving the "Turn" slider from the keyboard, shows its count and the change
from the turn before, with the output per turn as bars under it. Beside the curve (under it when narrow), where
the context went since the segment's start: one bar per source, largest first, with the estimate's caveat once
under them. The list carries the last 200 turns of each session; the detail view asks the host for all of them,
and says "last 200 of 233 turns" only if the host cannot answer. Two tables follow: the prompt cache and
output, and the session (working folder, process id and session id with a copy button). The view follows the
live list, says so if the session leaves the registry, and goes back to the list on Escape or the back
button; the panel remembers the open session, and a browser host keeps it in the address (`#<sessionId>`).

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
see every live session on the machine, grouped by project. Click a group heading to fold it; click the
refresh button (the circling arrows) when you doubt what the list shows, for example right after a
process was ended: the list is read again from scratch.

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

The title of a session is its AI-generated title or, before there is one, the start of its first message,
or the first local command when only that ran ("/context all"). A session without any of these, such as a tab
opened and not written to, is "new session" with the name Claude Code gave it ("new session ·
my-project-08"), muted, and says "no turns yet" with "—" for the count. The panel only shows titles locally,
but they can contain whatever was typed, so keep that in mind when sharing your screen.

## How it works

Claude Code keeps one small file per running process in `~/.claude/sessions/` and the transcript of
every session in `~/.claude/projects/<project>/<sessionId>.jsonl` (`~/.claude` is `%USERPROFILE%\.claude`
on Windows; `CLAUDE_CONFIG_DIR` moves it). The extension joins the two, parses only the new bytes of a
transcript on every change (`fs.watch` on the folders, debounced, plus a 30-second tick) and pushes the
list to the webview. While a session is open, the webview asks for every turn of it after each list (the
message `{ type: "detail", sessionId }`; a browser host serves `/claude-context/api/detail?session=<id>`), and
the host answers from the state it already parsed, without reading the transcript again.

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
