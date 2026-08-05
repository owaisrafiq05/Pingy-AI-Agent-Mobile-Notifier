# Pingy

**Get notified when your AI coding agent needs you.**

Your AI coding agent's little notification buddy.

**Cursor → Claude Code → Codex → More coming soon**

---

Pingy sends a mobile push (via [ntfy](https://ntfy.sh)) when your agent finishes, waits for permission, or hits an error — so you can step away from the keyboard without missing the moment you're needed.

**Author:** [Owais Rafiq](https://github.com/owaisrafiq05)

## Supported agents

| Agent | Status |
|-------|--------|
| **Cursor** | Supported now |
| **Claude Code** | Coming soon |
| **Codex** | Coming soon |
| More | Coming soon |

## Why Pingy

1. **Waiting alerts** — get pinged when the agent is blocked on an "Allow?" prompt
2. **One-time setup** — install once, pair your phone once; **every project** notifies
3. **Session context** — every push includes the project name and prompt when available

### What you get on your phone

| Event | Title | Body |
|-------|-------|------|
| Completed | Completed | Your agent cooked. Task's done 🔥 |
| Waiting | 👀 Waiting | Hey, your agent needs you |
| Error | 🚨 Error | Uh oh… your agent hit a snag 😬 |

Each description also includes **Project** and **Prompt**.

## Requirements

- Cursor IDE with Hooks support (v1.7+)
- Node.js on your PATH (hooks run `node ./hooks/cursorping.js …`)
- [ntfy](https://ntfy.sh) app on your phone (iOS / Android), or a self-hosted ntfy server

## Install

### From the marketplace

Search for **Pingy** in Cursor / VS Code extensions (publisher: `OwaisRafiq`).

### From source (this repo)

```bash
npm install
npm run compile
npm run package
```

In Cursor: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick `pingy-0.3.4.vsix`.

### After install (do this once)

1. Command Palette → **Pingy: Run Setup (once for all projects)**
2. **Pingy: Show Pairing QR Code** — subscribe to the topic in the ntfy app (iOS: paste the topic)
3. Optionally **Pingy: Send Test Notification**

That’s it. Open any other project and run the agent — you should get pings without setting up again.

### What setup writes (global)

Under your user Cursor folder (`~/.cursor` / `%USERPROFILE%\.cursor`):

- `hooks.json` — merges Pingy hooks (keeps your other hooks)
- `hooks/cursorping.js` (+ `lib/`)
- `hooks/cursorping.config.json` — topic + server URL (private to you)

## How it works

| Piece | Role |
|--------|------|
| **Hook bridge** | Cursor spawns a short-lived Node process on agent events; it posts to ntfy |
| **Extension** | One-time global install, QR pairing, status bar, test ping, pending watcher |

### Waiting-for-permission detection

Cursor exposes **no event for "an approval dialog is open"**, and no VS Code API can see Cursor's chat UI. What the hooks API does give us is both edges of the gate the dialog sits in:

| Phase | Hook events | What Pingy does |
|-------|-------------|-----------------|
| Gate opens | `preToolUse`, `beforeShellExecution`, `beforeMCPExecution` | Record an open gate for the conversation |
| Gate closes | `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `afterMCPExecution`, `afterFileEdit`, `afterAgentResponse`, `afterAgentThought`, `subagentStop`, `stop` | Clear it |

A gate that stays open past `cursorping.pendingTimeoutMs` with no follow-up event means the agent loop is blocked — it cannot think, run tools, or finish while a prompt is up. `preToolUse` fires for every tool, so web search, MCP calls, subagents, and file operations are covered, not just terminal commands.

The extension does the timing, because a hook is a short-lived process that must exit immediately and cannot wait out a timeout. It is also the **only** sender of these notifications, which is what guarantees one ping per prompt.

Two things keep it honest:

- **No duplicates.** A gate is marked notified and keeps that flag until a hook clears it, so a prompt left open all afternoon pings once. Approving or rejecting clears the gate and re-arms the next alert. Writes are compare-and-set, so a hook resolving a gate mid-send is never clobbered.
- **No false alarms from slow commands.** Where VS Code shell integration is available, a shell gate whose command is observably executing is treated as busy rather than blocked. This is best-effort corroboration; without it, detection falls back to the timeout alone.

The hook script is strictly observe-only and never returns a permission decision — doing so would auto-approve the action and hide the very prompt we are trying to detect.

Tune `cursorping.pendingTimeoutMs` (default `2000`) if slow tools still false-trigger.

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `cursorping.serverUrl` | `https://ntfy.sh` | ntfy base URL (self-host friendly) |
| `cursorping.pendingTimeoutMs` | `2000` | How long a gate may stay open before it counts as waiting on you |
| `cursorping.pendingMaxAgeMs` | `1800000` | After this, an unresolved gate is treated as abandoned, not waiting |
| `cursorping.watcherIntervalMs` | `1000` | Extension poll interval |

## Tests

```bash
npm test
```

Covers the gate state machine (one notification per request, re-arming after approve/reject, no duplicates, race handling) and runs the hook bridge end to end against a stub ntfy server.

## Manual smoke test

```bash
# after Run Setup (global install)
echo {"conversation_id":"t","status":"completed","workspace_roots":["D:/foo/checkout-api"]} | node %USERPROFILE%\.cursor\hooks\cursorping.js stop
```

## Limitations

- Hooks are relatively new; field names may change. Pin against the [official docs](https://cursor.com/docs/agent/hooks).
- "Waiting for permission" is inferred from a silent gap between documented hook events, because Cursor has no first-class signal for it. A tool that blocks for longer than the timeout without shell integration to vouch for it can still ping early.
- Permission alerts need the extension running; a hooks-only install still gets completion alerts.
- ntfy topics are public-by-obscurity; use a self-hosted server if that matters.
- Cursor CLI agent hooks are not promised until officially supported.
- Claude Code and Codex support are on the roadmap — not available in this release.

## Prior art (reference, not forks)

- [cursor-ntfy-on-stop-hook](https://github.com/beautyfree/cursor-ntfy-on-stop-hook)
- [ai-agent-notifier](https://github.com/DevinoSolutions/ai-agent-notifier)
- [cursor-agent-notifier](https://github.com/hgbdev/cursor-agent-notifier)
- [GitButler hooks deep dive](https://blog.gitbutler.com/cursor-hooks-deep-dive)

## License

MIT

## Author

**Owais Rafiq** — [github.com/owaisrafiq05](https://github.com/owaisrafiq05)
