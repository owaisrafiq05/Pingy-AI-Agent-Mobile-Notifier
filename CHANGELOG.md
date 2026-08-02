# Changelog

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
