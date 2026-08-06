# Pingy

**Get notified when your AI coding agent needs you.**

Your AI coding agent's little notification buddy — step away from the keyboard without missing the moment you're needed.

[![GitHub stars](https://img.shields.io/github/stars/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier?style=social)](https://github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

⭐ **[Star the repo](https://github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier)** if Pingy helps you — it means a lot and helps others find the project.

**Author:** [Owais Rafiq](https://github.com/owaisrafiq05)

---

## Getting Started

Follow these steps once to connect Pingy to your phone. After that, it works across all your Cursor projects.

### 1. Install the extension

In Cursor, open the **Extensions** marketplace and search for **Pingy** or **cursorping**. Install the **Pingy** extension (publisher: `OwaisRafiq`).

### 2. Show the pairing QR code

Press `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`) to open the Command Palette, then run:

**Pingy: Show Pairing QR Code**

A window appears with your private topic (for example `pingy-xxxxxxx`) and a QR code.

> Tip: If this is your first install, also run **Pingy: Run Setup (once for all projects)** so hooks are installed globally.

### 3. Install the ntfy app

Download **[ntfy](https://ntfy.sh)** from the [Google Play Store](https://play.google.com/store/apps/details?id=io.heckel.ntfy) or the [Apple App Store](https://apps.apple.com/app/ntfy/id1625396347).

### 4. Subscribe to your topic

1. Open the ntfy app
2. Tap the **+** (subscribe) button
3. Enter the topic shown in the pairing window (e.g. `pingy-xxxxxxx`)
4. Tap **Subscribe**

You can also scan the QR code where the app supports it (on iOS, paste the topic name if scanning is unavailable).

### 5. Send a test notification

Back in Cursor, press `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`) and run:

**Pingy: Send Test Notification**

You should receive a push on your phone confirming that **Pingy is live**.

### 6. You're all set

Pingy is now connected to Cursor. Keep coding — you'll get mobile alerts when your agent finishes, waits for permission, or hits an error.

---

## Why Pingy

1. **Waiting alerts** — get pinged when the agent is blocked on an "Allow?" prompt
2. **One-time setup** — install once, pair your phone once; every project notifies
3. **Session context** — every push includes the project name and prompt when available

### What you get on your phone

| Event | Title | Body |
|-------|-------|------|
| Completed | Completed | Your agent cooked. Task's done 🔥 |
| Waiting | 👀 Waiting | Hey, your agent needs you |
| Error | 🚨 Error | Uh oh… your agent hit a snag 😬 |

Each notification also includes **Project** and **Prompt** when available.

## Supported agents

| | Agent | Status |
|---|-------|--------|
| <img src="media/logos/cursor.png" alt="Cursor" width="22" height="22" /> | **Cursor** | Supported now |
| <img src="media/logos/claude.png" alt="Claude" width="22" height="22" /> | **Claude Code** | Coming soon |
| <img src="media/logos/openai.png" alt="Codex" width="22" height="22" /> | **Codex** | Coming soon |
| | More | Coming soon |

## Open Source & Contributing

Pingy is open source and publicly available at  
[github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier](https://github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier).

Want to contribute?

1. Fork the repository
2. Create a new branch for your change
3. Open a pull request with a clear description of what you added or fixed

I'll review PRs and give credit for merged features. Ideas, bug reports, and improvements are all welcome.

⭐ If you like the project, please [star the repo](https://github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier) — it helps a lot.

## License

MIT

## Author

**Owais Rafiq** — [github.com/owaisrafiq05](https://github.com/owaisrafiq05)
