# CursorPing

Push a mobile notification when the **Cursor Agent** finishes — or when it looks like it's waiting on your approval.

Built on Cursor's official [Hooks API](https://cursor.com/docs/agent/hooks) (`stop`, `beforeShellExecution`, `afterFileEdit`). Notifications go through [ntfy](https://ntfy.sh) (no signup required).

## Why CursorPing

Existing tools mostly notify on `stop`. CursorPing adds:

1. **Needs-you alerts** — timing heuristic on `beforeShellExecution` when no follow-up arrives within a configurable window
2. **Real extension UX** — setup wizard, QR pairing, status bar, test notification (not just a manual `hooks.json` edit)
3. **Session context** — titles include the project name and distinguish `completed` / `error` / `aborted`

## Requirements

- Cursor IDE with Hooks support (v1.7+)
- Node.js on your PATH (hooks run `node .cursor/hooks/cursorping.js …`)
- [ntfy](https://ntfy.sh) app on your phone (iOS / Android), or a self-hosted ntfy server

## Install

### From source (this repo)

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

Install the generated `.vsix` in Cursor: **Extensions → … → Install from VSIX…**

### After install

1. Open a project folder
2. Command Palette → **CursorPing: Run Setup**
3. Command Palette → **CursorPing: Show Pairing QR Code** (or tap the prompt after setup)
4. Scan the QR in the ntfy app (or subscribe to the shown topic)
5. Optionally run **CursorPing: Send Test Notification**

Setup writes project-level:

- `.cursor/hooks.json`
- `.cursor/hooks/cursorping.js` (+ `lib/`)
- `.cursor/hooks/cursorping.config.json` (topic + server URL)

Commit `hooks.json` and the hook scripts if you want the team to share them. **Do not commit** `cursorping.config.json` if the topic should stay private to you (or rotate the topic). Prefer adding `.cursor/hooks/cursorping.config.json` and `.cursor/hooks/state/` to `.gitignore` when sharing.

## How it works

Two decoupled pieces:

| Piece | Role |
|--------|------|
| **Hook bridge** | Cursor spawns a short-lived Node process on agent events; it posts to ntfy |
| **Extension** | Writes hook files, QR pairing, status bar, test ping, and a background pending watcher |

The notification pipeline does **not** depend on the extension host receiving hook events (it can't). The extension is the setup/UX layer; the hook scripts do the actual notify.

### Needs-approval detection

1. **Option A** — each hook invocation checks `.cursor/hooks/state/pending.json` for stale entries
2. **Option B** — while the extension is active, it polls the same file every few seconds

A slow legitimate shell command can still produce a false "needs you" alert. Tune `cursorping.pendingTimeoutMs` (default 15000).

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `cursorping.serverUrl` | `https://ntfy.sh` | ntfy base URL (self-host friendly) |
| `cursorping.pendingTimeoutMs` | `15000` | Stale pending threshold |
| `cursorping.watcherIntervalMs` | `5000` | Extension poll interval |

## Manual / hook-only smoke test

```bash
# after Run Setup (or copy hooks-template manually and add cursorping.config.json)
echo {"conversation_id":"t","status":"completed","workspace_roots":["D:/foo/checkout-api"]} | node .cursor/hooks/cursorping.js stop
```

## Global hooks (optional)

Project-level `.cursor/hooks.json` is what Setup writes. For every workspace, you can instead use user-level `~/.cursor/hooks.json` — see [Cursor hooks docs](https://cursor.com/docs/agent/hooks). CursorPing does not install that path automatically in v0.1.

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
