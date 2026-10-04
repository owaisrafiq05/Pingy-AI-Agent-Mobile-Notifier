# Changelog

## 0.4.2

- **Fix: one Cursor turn no longer pushes three "Completed" alerts.** Cursor runs
  project hooks, user hooks, and (via third-party imports) Claude Code `Stop`
  hooks on the same turn. Completions are now claimed once across project +
  global Cursor hooks, and the Claude Code entrypoint no-ops when Cursor is the
  host — so you get a single `Agent: Cursor` push, not Cursor×2 + a false
  `Agent: Claude Code`

## 0.4.1

Fixes the Claude Code notifications shipped in 0.4.0. Measured against a real
session: 23 "Waiting" pushes in 16 minutes of ordinary work, all for the same
turn.

- **No more waiting-alert spam.** Claude Code raises a `Notification` for every
  approval dialog, and in `default` permission mode a single turn opens one per
  tool call. A waiting push means "come back to your terminal", so it now fires
  once per turn — re-armed by your next prompt, by the turn ending, or after
  `cursorping.waitingRepingMs` (default 5 minutes) if the agent is still blocked
- **No more "your agent needs you" right after "task's done".** Claude Code emits
  `idle_prompt` 60 seconds after a turn ends; that is the state the completion
  push already reported, so it is now suppressed once a turn has been reported done
- **Waiting pushes say what is needed** — Claude Code's own text ("Claude needs
  your permission to use Bash") is carried into the body as a `Needs:` line, and
  `StopFailure` pushes name the error (`Error: rate_limit — …`)
- Waiting alerts now also cover `worker_permission_prompt` and the MCP
  `elicitation_dialog` / `elicitation_url_dialog` cases, which block the agent on
  you just as much as a tool approval did
- A turn that stops twice (a Stop hook forcing the agent onward, background work
  waking the session) is one completion push, not two
- A completion that leaves background work running says so instead of claiming
  the session is idle
- Prompt context no longer reads "(not available for this run)" on resumed
  sessions: the transcript reader understands Claude Code's `{type:"user",
  message:{role,content}}` shape, string content included, and skips tool results
  and injected turns
- A `Stop` payload of `null` no longer exits 1 out of the hook, which Claude Code
  surfaces as a hook error in the terminal
- When Claude Code reports a machine-driven turn source (`/loop` ticks, scheduled
  wake-ups), those turns no longer push a completion; a blocked one still pushes
- New: `npm run test:e2e` drives the real `claude` CLI against a stub ntfy server,
  so a renamed event or payload field fails a test instead of going unnoticed

### Cursor: no more "waiting for your response" when nothing was asked

Cursor fires its gate events (`preToolUse`, `beforeShellExecution`,
`beforeMCPExecution`) whether or not you are ever prompted, so an auto-run command
that took a moment looked exactly like a pending approval. Three things caused the
false alerts, and all three are fixed:

- **`preToolUse` gates no longer alert at all.** They fire for every tool the agent
  uses — reads, searches, edits — and Cursor applies those itself, so a slow one
  meant "busy", never "waiting". The gates Cursor really prompts for (shell, MCP)
  arrive on their own events, and the hook now records that distinction in
  `pending.json` as `promptable`
- **The terminal-activity guard was inert where it mattered.** It trusted its own
  silence whenever VS Code merely *exposed* the shell-integration API; Cursor's
  agent terminal frequently reports nothing, so "no command running" was the answer
  for every command. It now requires having actually observed an execution before
  its silence counts as evidence
- **The threshold was 2 seconds** (`pendingTimeoutMs`), far below how long a normal
  auto-run tool call takes. Replaced by `cursorping.waitingAfterMs`, default 45s —
  a real prompt waits for a human, so patience costs nothing. `pendingTimeoutMs` is
  deprecated and no longer affects waiting alerts, including in config files left
  behind by older installs
- **New guard: nobody gets buzzed while they are at the window.** A waiting push
  means "come back to your terminal"; if you are typing in Cursor there is nothing
  to come back to. Presence is measured from mouse and keyboard signals only —
  agent edits deliberately do not count, and a window left focused while you walk
  away goes idle and stops suppressing
- Shell gates that terminal activity cannot vouch for now stay silent by default,
  since installs and builds legitimately run for minutes. Set
  `cursorping.alertOnUnconfirmedShellWaits` to `true` if you never use auto-run and
  would rather have the alert
- A generic `preToolUse` gate can no longer overwrite a shell or MCP gate that
  opened moments earlier, which would have hidden a real prompt from the watcher

## 0.4.0

- **Claude Code support.** Setup now installs hooks for both agents — `~/.cursor/hooks.json` and `~/.claude/settings.json` — in one run
- Both agents publish to the **same ntfy topic**, so existing users get Claude Code notifications without re-pairing or a second subscription
- Claude Code waiting alerts come from its real `Notification` event (`permission_prompt` / `idle_prompt` / `agent_needs_input`), so there is no timeout heuristic and no false "waiting" pings — none of Cursor's pending-gate machinery runs on the Claude path
- Completion via `Stop`, errors via `StopFailure`, prompt context via `UserPromptSubmit`
- Notification bodies gain an `Agent:` line (`Cursor` / `Claude Code`) so a push is attributable when both agents run in the same project
- `~/.claude/settings.json` is merged, never overwritten: unrelated settings and other tools' hooks survive, re-running setup never stacks duplicates, and an unreadable file is backed up to `settings.json.bak-<timestamp>`
- The Claude hook never writes to stdout and always exits 0 — exit code 2 would block the agent, and `UserPromptSubmit` stdout would be injected into the model's context
- Harness-injected turns (background task notifications, system reminders, slash-command output) are no longer stored as "the prompt"; because the first prompt is sticky, one of these would otherwise head every push for the rest of the session. Stored prompts are also capped so the state file cannot grow unbounded
- Hooks are loaded when a Claude Code session starts, so **restart Claude Code after running setup** — the README and setup message both call this out
- README documents a manual install for Claude Code CLI users who don't run the extension

## 0.3.5

- Refresh marketplace README: clear Getting Started steps, agent logos, star/contribute section

## 0.3.4

- Keep Open VSX slug as `OwaisRafiq.cursorping` while product branding stays **Pingy**
- Fix false “waiting” notifications: hooks no longer push waiting alerts; shell waits need terminal-activity corroboration

## 0.3.3

- Product branding: **Pingy — Get notified when your AI coding agent needs you**
- Tagline: *Your AI coding agent's little notification buddy*
- Roadmap callout: Cursor → Claude Code → Codex → More coming soon
- Positions the waiting / permission notification as a core Pingy feature

## 0.3.2

- New Pingy extension logo (white ringing bell on a blue-gradient rounded hexagon)
- Extension metadata credits author [Owais Rafiq](https://github.com/owaisrafiq05)

## 0.3.1

- Rebrand to **Pingy**
- New notification copy:
  - Completed — "Your agent cooked. Task's done 🔥"
  - 👀 Waiting — "Hey, your agent needs you"
  - 🚨 Error — "Uh oh… your agent hit a snag 😬"
- Description includes project + prompt
- Publish via ntfy JSON API so emoji titles are preserved

## 0.3.0

- Notify when the Agent is waiting for your permission — "Cursor needs your attention" / "The Agent is waiting for your permission to continue."
- Detection now covers every approval gate, not just terminal commands: `preToolUse` (web search, file tools, subagents), `beforeShellExecution`, and `beforeMCPExecution`
- Gates are closed by `postToolUse`, `postToolUseFailure` (including `permission_denied`), `afterShellExecution`, `afterMCPExecution`, `afterFileEdit`, `afterAgentResponse`, `afterAgentThought`, and `subagentStop`, so approving or rejecting re-arms the next alert
- **Fix:** the `beforeShellExecution` hook no longer answers `{"permission":"allow"}`, which was silently auto-approving every terminal command and suppressing the prompt this feature detects
- Exactly one notification per permission request: the extension watcher is the only sender, entries stay deduped until a hook clears them, and writes are compare-and-set against concurrent hook processes
- Shell gates are cross-checked against VS Code terminal shell integration where available, so a slow command is not mistaken for a prompt
- Abandoned gates expire via `cursorping.pendingMaxAgeMs` (default 30 min)
- Add `npm test` covering the gate state machine and the hook bridge end to end

## 0.2.2

- Replace extension icon with CursorPing brand logo

## 0.2.1

- Notifications include project name plus the chat's initial (and latest) user message
- Capture prompts via `beforeSubmitPrompt` and fall back to `transcript_path` when available

## 0.2.0

- One-time global setup via `~/.cursor/hooks.json` — all projects notify after a single install + phone pairing
- Setup merges into existing user hooks instead of overwriting them
- Pairing / test / watcher use the global config (legacy per-project config still works as fallback)

## 0.1.3

- Humanize notification titles and body copy (finish / error / aborted / needs you / test)

## 0.1.2

- Fix VSIX packaging so `qrcode` JS is included (QR was falling back to Copy URL only)
- Pairing panel always opens with topic/URL; QR when available

## 0.1.1

- Fix activation so commands always register (lazy-load QR lib; register commands first)
- Explicit `onCommand` activation events

## 0.1.0

- Initial release: Node hook bridge for `stop`, `beforeShellExecution`, and `afterFileEdit`
- ntfy notifications with project name and status-aware titles
- Pending-approval detection (hook piggyback + extension watcher)
- VS Code/Cursor extension: setup wizard, pairing QR, status bar, test notification
