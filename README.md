# Claude Context

A VS Code panel that shows the context window of every live Claude Code session on the machine, updated
in real time.

## What the panel shows

### Zones

Every session is in a zone by its token count: green below 100K, yellow below 125K, orange up to 150K, red
above. The zones are absolute token counts, not a share of the model's window: they follow Matt Pocock's
smart zone and dumb zone, where the dumb zone "commonly begins around 125K-150K tokens". They warn about
quality, not about the window limit.

### Header

The count of live sessions and a zone meter (how many sessions are in each zone); the warm and cold prompt
caches; the median start of the sessions that began fresh, so a CLAUDE.md that grew shows at a glance; and
"3 idle over an hour" when there are such sessions. While a filter hides sessions it says "showing 4 of 10".
At the right end, the compact switch and the refresh button: refresh reads the registry and every transcript
again from the first byte, and says "updated 12:04:31" when done.

### Groups

The sessions sit under four group headings, in this order:

- **Working now**: busy sessions, whose dot pulses.
- **Waiting for you**: a session that waits for a permission prompt, a question or a dialog, with an
  outlined "waiting" pill that does not move. It is never hidden or folded away, however long it has waited.
- **Idle**: the rest. A session with no turn for more than an hour is dimmed.
- **Idle over an hour**: a session that is neither busy nor waiting and had neither a turn nor its process
  start for an hour (an empty one by its start alone), folded until you open it. VS Code keeps a chat tab's
  process running after the tab is closed, until **Developer: Reload Window**, and nothing tells a closed tab
  from an open one (`NOTES.md`, "Closed chat tabs"), so most of these are probably closed tabs.

Every group heading (and, with all projects, each project) folds and unfolds on a click, keeping its count;
the panel remembers which are folded.

### A row

One row per session:

- The title, and the count in the zone colour with the zone's name under it.
- A context bar scaled 0–200K with marks at 100K, 125K and 150K; its tooltip says what to do at the next
  phase boundary in the yellow, orange and red zones. Its first part, in a muted shade, is the start of the
  session: the first turn, which holds the fixed load (CLAUDE.md, memory, skill and tool listings) and the
  first message ("start 29K · conversation 87K"; after a compaction it starts again at the first turn after it).
- Under the bar, an estimate of where the conversation's growth went ("≈ Bash 50K · output 46K · Read 27K"):
  per turn, what the model wrote first, the rest split by length over the tool results, your messages and
  attachments; every source in the tooltip.
- A sparkline of tokens per turn, with a solid mark at every compaction Claude Code recorded (the tooltip says
  whether it was automatic and the count before and after) and a dotted one at any other sharp drop (a
  `/clear` starts a new transcript, so it starts a new curve). Thin bars under it show the output tokens per
  turn, the thinking part drawn stronger.
- The model with the effort of the last turn ("Opus 5.5 · xhigh"), the number of turns, the output tokens of
  the session ("44K out"; the tooltip has the last turn and the thinking share) and the time since the last turn.
- The prompt cache: "warm · 47 min" counts down to the moment the cache goes cold (the last turn plus the TTL
  Claude Code chose, shown as a 1h or 5m pill; a drop to 5m is marked). A few minutes before that the text
  turns orange, and afterwards it says "cold". The tooltip has the deadline, how much of the last turn's
  context was read from cache and how much was written.

The rows stack in the narrow sidebar and spread over four columns when the panel is 620 px or wider.

### Compact rows

The button beside refresh (three stacked bars) switches to compact rows: each session is only its title line,
with the busy or waiting pill and the count, and the context bar under it, so many more fit in the sidebar.
The detail view is a click away as before, and the panel remembers the choice.

### Controls

The control row under the header starts with the scope switch, which says what the list, and every counter
above it, is about: "This workspace" (the default, the sessions inside the window's workspace folders, named
beside the switch, with "4 more in other projects" when other projects have live sessions; a click shows them)
or "All projects" (the whole machine, grouped by project). Then the sort, which orders the rows inside each
group (last turn, context size, time until cold, started, title; rows without a value go last), and the
filters on the two idle groups: show only the orange and red zones, or switch a model off with its chip. A busy
or waiting session is never hidden; the header keeps counting everything, a group heading says "4 of 9" while
a filter is on, and "reset" puts the view back. The view is remembered like the folds.

### Detail view

Click a row (or press Enter on it) to open the session's detail view in its place:

- The title, project, model and effort, turns, start and last turn.
- A box edged in the zone colour that says what the number is ("Context 138K · orange zone"), that the zones
  warn about quality at 100K, 125K and 150K and not about the window limit, and, in yellow, orange and red,
  what to do at the next phase boundary ("Break at the first phase boundary; continue only if the next phase
  fits under 150K."). Under it the named facts: "Session started at 29K" (or "This segment started at 169K"
  after a compaction) and "Compactions 1" when there was one.
- A large curve of tokens per turn over the whole session, with the four zone bands, every compaction labelled
  with its trigger and counts, and the segment's start. Under it, in a field half its height on the same
  turns, the output per turn with its thinking part, on its own scale with the largest value in the corner.
  Hovering a turn in either field, or moving the "Turn" slider under them from the keyboard, shows its count,
  the change from the turn before, and its output and thinking.
- Beside the curve (under it when narrow), where the context went since the segment's start: one bar per
  source, largest first, with one short line on how it is estimated (the whole of it in the tooltip).
- Two tables: the prompt cache and output, and the session (what a fresh session here typically starts at,
  from the header's start median; working folder, process id and session id with a copy button).

The list carries the last 200 turns of each session; the detail view asks the host for all of them, and says
"last 200 of 233 turns" only if the host cannot answer. The view follows the live list, says so if the
session leaves the registry, and goes back to the list on Escape or the back button; the panel remembers the
open session.

## The code

No dependencies, no build step: `extension.js` (the host), `core.cjs` (the pure functions, and the reader
and watcher of Claude Code's files) and `panel.html` (the webview). The panel runs in VS Code only.

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

The panel starts with the sessions of this window's workspace; **All projects** shows the whole machine
("Controls" above). Click the refresh button (the circling arrows) when you doubt what the list shows, for
example right after a process was ended: the list is read again from scratch.

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
message `{ type: "detail", sessionId }`), and
the host answers from the state it already parsed, without reading the transcript again.

The transcript format is Claude Code's internal one and can change between versions. A field the panel
cannot find shows as "unknown"; nothing throws.

## Development

```
npm install
npm test        # Vitest; the same suite runs on Ubuntu and Windows in GitHub Actions
```

`NOTES.md` holds the facts measured about Claude Code's files; `CLAUDE.md` is how the repo is worked on.

## License

MIT, see `LICENSE`.
