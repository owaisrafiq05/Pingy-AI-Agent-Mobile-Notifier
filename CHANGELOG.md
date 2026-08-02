# Changelog

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
