# Plan: Windows and Amazon Bedrock support

Written 2026-10-22. This plan is meant to be run by Claude Code on the Windows machine, with the owner
judging the result. Every step ends with a check, and no code is written before step 2 has produced the
facts the plan lacks. Record what you find in `NOTES.md` instead of guessing around it.

## What is already done (the seed commit)

- The extension, the tests and the fixtures are in this repo, all in English: `extension.js`, `core.cjs`,
  `panel.html`, `icon.svg`, `package.json`, `test/`.
- `npm test` runs Vitest (34 tests, green on macOS), and `.github/workflows/test.yml` runs the same suite on
  `ubuntu-latest` and `windows-latest` on every push.
- `README.md`, `LICENSE` (MIT), `.gitignore`.

## What is known

Documented by Claude Code (code.claude.com/docs: `claude-directory`, `sessions`, `env-vars`, `agent-view`,
`amazon-bedrock`, `changelog`; see `NOTES.md` for the details):

- The default folder is `%USERPROFILE%\.claude` on Windows. `CLAUDE_CONFIG_DIR` moves everything, including
  `sessions/` and `projects/`; it is read from the environment, never from project settings. VS Code does
  not necessarily see the same environment variables as a terminal.
- The folder name under `projects/` is the working directory with every non-alphanumeric character replaced
  by `-`. Names over 200 characters are truncated and get a hash (undocumented algorithm).
  `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+) can override the name when `CLAUDE_CONFIG_DIR` is also set.
  There is no documented Windows example; the rule gives `C:\Users\frode\Dev\Repo` → `C--Users-frode-Dev-Repo`.
- `sessions/` holds one small file per running process, on Windows too (changelog 2.1.246). The fields are
  undocumented; `claude agents --json` documents `pid`, `cwd`, `status` (`busy`, `waiting`, `idle`),
  `sessionId`, `startedAt`. The core reads `pid`, `sessionId`, `cwd`, `status`.
- The transcript format is internal and may change between versions.
- Bedrock: what `message.model` contains in the transcript (`us.anthropic.claude-opus-5-5…` or
  `claude-opus-5-5`) is undocumented. Changelog 2.1.152: cache writes may sit nested in
  `usage.cache_creation` instead of flat in `cache_creation_input_tokens`. Prompt caching may be unavailable
  in some Bedrock regions (zeros in the cache fields).
- Git Bash versus PowerShell changes only the Bash tool, not the file locations. Under WSL, `~/.claude` is
  inside the Linux home, not `%USERPROFILE%`.

Known bugs in `core.cjs` on Windows: `inFolder` compares with `/` as the separator, and `projectName`
splits on `/`. Both fail when `cwd` comes with `\`. `projectSlug` follows the documented rule and is
probably right. `isAlive` uses `process.kill(pid, 0)`, which Node documents for Windows. `fs.watch` works
on local disks; the 30-second tick covers network drives where it does not fire.

## Step 0 – Prerequisites on the Windows machine

Check in PowerShell and record the versions in `NOTES.md`:

```powershell
code --version          # first line >= 1.131.0 (package.json engines)
git --version
node --version          # >= 20, only for the tests
claude --version
```

Claude Code must already run against Bedrock as usual (`CLAUDE_CODE_USE_BEDROCK=1` and the AWS setup).

## Step 1 – Clone

```powershell
cd $env:USERPROFILE\Dev
git clone https://github.com/frodemathiass1/claude-context-vscode
cd claude-context-vscode
npm install
npm test
```

Check: `npm test` is green on Windows before anything is changed. If it is not, that is the first finding
for `NOTES.md` and the first fix.

## Step 2 – Verify the facts on Windows before writing any code

Start a Claude Code session in the clone (so there is something to show), leave it running, and do the
following in another PowerShell. Everything goes into `NOTES.md` verbatim, without sensitive content.

1. **The registry.** `Get-ChildItem $env:USERPROFILE\.claude\sessions` and `Get-Content` on `<pid>.json`.
   Record the field names, the form of `cwd` (`C:\…` with `\`? forward slashes?) and the values `status`
   takes (`busy`, `idle`, `waiting`?). If `CLAUDE_CONFIG_DIR` is set (`$env:CLAUDE_CONFIG_DIR`), the folder
   is there instead.
2. **The project folder.** `Get-ChildItem $env:USERPROFILE\.claude\projects`. Record the folder name for the
   clone and compare it with the rule (`C--Users-<you>-Dev-claude-context-vscode`). If the path has
   non-ASCII letters or spaces, record what they became.
3. **The transcript.** In the project folder, the last assistant line of `<sessionId>.jsonl`:

   ```powershell
   Select-String -Path "<sessionId>.jsonl" -Pattern '"type":"assistant"' | Select-Object -Last 1 | ForEach-Object Line
   ```

   Record `message.model` verbatim and the whole `message.usage` object (flat fields, possibly a nested
   `cache_creation`). Also check whether `message.id` and `isSidechain` are present on the lines.
4. **The environment VS Code sees.** Open VS Code from the Start menu (not from a terminal), open an
   integrated terminal and run `$env:CLAUDE_CONFIG_DIR` and `$env:CLAUDE_CODE_USE_BEDROCK`. If they are empty
   there but set in the normal terminal, the extension needs its own setting (step 3, item 4).

Check: `NOTES.md` answers all four. Steps 3 and 4 build on the answers, so do not guess them.

## Step 3 – Windows paths in `core.cjs` and the config folder in `extension.js`

1. **`inFolder(cwd, folder)`:** normalise both to `/` (`s.replace(/\\/g, "/")`), drop a trailing `/`, and
   compare case-insensitively when `process.platform === "win32"` (VS Code can give `c:\…` where the
   registry has `C:\…`). The rule stays "equal, or starts with the folder plus a separator".
2. **`projectName(cwd)`:** split on `/[\\/]/`.
3. **The project folder:** keep `projectSlug` as it is (the documented rule). When the slug folder does not
   exist, search the folders in `projects/` for one that contains `<sessionId>.jsonl`, and remember the hit
   per sessionId in `SessionReader.cache`. That covers the hash truncation over 200 characters,
   `CLAUDE_CODE_PROJECT_DIR_NAME` and non-ASCII characters without guessing. "Project folder not found"
   remains only when the search finds nothing either. If step 2 item 2 showed that the rule does not hold
   on Windows, fix `projectSlug` after what was actually written and add it as a test case.
4. **The setting `claudeContext.claudeDir`** in `package.json` under `contributes.configuration` (type
   string, default empty, description "Folder Claude Code stores its data in. Empty: CLAUDE_CONFIG_DIR, else
   ~/.claude. Reload the window after changing it."). `extension.js` reads it at activation: setting →
   `CLAUDE_CONFIG_DIR` → `~/.claude`. No change listener; a reload is the smallest solution. Required when
   step 2 item 4 showed that VS Code does not see `CLAUDE_CONFIG_DIR`; otherwise a fallback.
5. **`status`:** `busy` still means busy. If step 2 showed that `waiting` exists, it is not busy (the session
   waits for you), so no change, but record it.

Tests for every item: `projectSlug("C:\\Users\\frode\\Dev\\Repo")` is `C--Users-frode-Dev-Repo`; `inFolder`
with `\`, mixed separators and a different case of the drive letter; `projectName` with `\`; the fallback
lookup against a temporary `projects/` folder where the slug folder is missing. The existing tests build
their paths with `path.join`, so they must stay green on Windows as they are.

Check: `npm test` green on the Windows machine and in Actions on both runners.

## Step 4 – Bedrock transcripts

Build on what step 2 item 3 showed, and add the real line (text anonymised) as the fixture
`test/fixtures/transcripts/bedrock.jsonl`.

1. **`modelShort`:** find `claude-<name>-<n>-<m>` anywhere in the string (`/claude-([a-z]+)-(\d+)-(\d+)/`),
   so both `us.anthropic.claude-opus-5-5-…-v1:0` and `claude-opus-5-5` give "Opus 5.5". Outside the pattern
   the string is shown as it is, as today.
2. **Tokens:** `cache_creation_input_tokens` as before; when the field is missing but `usage.cache_creation`
   is an object, count the sum of its numeric fields (`ephemeral_5m_input_tokens`,
   `ephemeral_1h_input_tokens`). `hasInputCounters` must accept the nested form. If all cache fields are
   zero in the region, the number is just `input_tokens`; that is correct.
3. If step 2 showed that `message.id` or `isSidechain` is missing on Bedrock, the rules in `parseTranscript`
   still apply: an entry without an id does not count as a new turn, and a missing `isSidechain` means "not
   a sidechain".

Check: the test for `bedrock.jsonl` gives the right token count and "Opus 5.5" (or whatever the model is).

## Step 5 – Install and judge in VS Code

1. Ctrl+Shift+P → **Developer: Install Extension from Location…** → pick the clone → **Developer: Reload
   Window**.
2. The "Claude Context" icon in the activity bar. With a Claude Code session open in the window's folder:
   the row shows the title, "Opus 5.5" (or what Bedrock calls it), tokens and zone, and the dot pulses while
   the session works.
3. The "All projects" toggle shows sessions from the whole machine grouped by folder.
4. Errors in the panel: "Registry folder not found" → the setting `claudeContext.claudeDir` (step 3, item
   4). "Project folder not found" → record the folder name that actually exists and fix step 3, item 3.
5. Updating later: `git pull` + **Developer: Reload Window**.

Check: the owner sees their own session in the panel. That is the judgement; the tests cover the rest.

## Step 6 – README

Update `README.md` with the setting `claudeContext.claudeDir` and anything step 2 taught about Windows
and Bedrock that a user needs to know.

Check: the README steps work verbatim on a fresh clone.

## Later, outside this repo

The project this extension was extracted from still has its own copy and serves `panel.html` in a
browser through a dev server. That project switches to this repo (npm dependency from GitHub or
`git subtree`), adopts the renamed identifiers and routes listed in `NOTES.md`, and drops its copy. Not
part of this plan.

## Order and roles

Claude Code on Windows does steps 0 to 6 in order, with a commit per step. The owner does what Claude
cannot: reads off the facts in step 2 (Claude can run the commands, but the owner decides what is
sensitive to record) and judges the panel in step 5.
