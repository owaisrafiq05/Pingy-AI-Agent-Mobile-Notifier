# CursorPing

Push a mobile notification when the **Cursor Agent** finishes — or when it looks like it's waiting on your approval.

Built on Cursor's official [Hooks API](https://cursor.com/docs/agent/hooks) (`stop`, `beforeShellExecution`, `afterFileEdit`). Notifications go through [ntfy](https://ntfy.sh) (no signup required).

## Why CursorPing

1. **Needs-you alerts** — timing heuristic on `beforeShellExecution` when no follow-up arrives within a configurable window
2. **One-time setup** — install the extension once, pair your phone once; **every project** notifies
3. **Session context** — titles include the project name, and the body includes the chat's initial (and latest) user message when available

## Requirements

- Cursor IDE with Hooks support (v1.7+)
- Node.js on your PATH (hooks run `node ./hooks/cursorping.js …`)
- [ntfy](https://ntfy.sh) app on your phone (iOS / Android), or a self-hosted ntfy server

## Install

### From source (this repo)

```bash
npm install
npm run compile
npm run package
```

In Cursor: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick `cursorping-0.2.0.vsix`.

### After install (do this once)

1. Command Palette → **CursorPing: Run Setup (once for all projects)**
2. **CursorPing: Show Pairing QR Code** — subscribe to the topic in the ntfy app (iOS: paste the topic)
3. Optionally **CursorPing: Send Test Notification**

That’s it. Open any other project and run the agent — you should get pings without setting up again.

### What setup writes (global)

Under your user Cursor folder (`~/.cursor` / `%USERPROFILE%\.cursor`):

- `hooks.json` — merges CursorPing hooks (keeps your other hooks)
- `hooks/cursorping.js` (+ `lib/`)
- `hooks/cursorping.config.json` — topic + server URL (private to you)

## How it works

| Piece | Role |
|--------|------|
| **Hook bridge** | Cursor spawns a short-lived Node process on agent events; it posts to ntfy |
| **Extension** | One-time global install, QR pairing, status bar, test ping, pending watcher |

### Needs-approval detection

1. **Option A** — each hook invocation checks pending state for stale entries
2. **Option B** — while the extension is active, it polls the same file every few seconds

Tune `cursorping.pendingTimeoutMs` (default 15000) if slow shells false-trigger “needs you”.

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `cursorping.serverUrl` | `https://ntfy.sh` | ntfy base URL (self-host friendly) |
| `cursorping.pendingTimeoutMs` | `15000` | Stale pending threshold |
| `cursorping.watcherIntervalMs` | `5000` | Extension poll interval |

## Manual smoke test

```bash
# after Run Setup (global install)
echo {"conversation_id":"t","status":"completed","workspace_roots":["D:/foo/checkout-api"]} | node %USERPROFILE%\.cursor\hooks\cursorping.js stop
```

## Limitations

- Hooks are relatively new; field names may change. Pin against the [official docs](https://cursor.com/docs/agent/hooks).
- "Needs approval" is a timing heuristic, not a first-class Cursor signal.
- ntfy topics are public-by-obscurity; use a self-hosted server if that matters.
- Cursor CLI agent hooks are not promised until officially supported.

## Prior art (reference, not forks)

- [cursor-ntfy-on-stop-hook](https://github.com/beautyfree/cursor-ntfy-on-stop-hook)
- [ai-agent-notifier](https://github.com/DevinoSolutions/ai-agent-notifier)
- [cursor-agent-notifier](https://github.com/hgbdev/cursor-agent-notifier)
- [GitButler hooks deep dive](https://blog.gitbutler.com/cursor-hooks-deep-dive)

## License

MIT
