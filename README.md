# Pingy

**Get notified when your AI coding agent needs you.**

Your AI coding agent's little notification buddy — step away from the keyboard without missing the moment you're needed.

[![GitHub stars](https://img.shields.io/github/stars/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier?style=social)](https://github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

⭐ **[Star the repo](https://github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier)** if Pingy helps you — it means a lot and helps others find the project.

**Author:** [Owais Rafiq](https://github.com/owaisrafiq05)

---

## Getting Started

Follow these steps once to connect Pingy to your phone. After that, it works across all your Cursor and Claude Code projects.

> Using the Claude Code CLI without Cursor or VS Code? Skip to [Claude Code without the extension](#claude-code-without-the-extension).

### 1. Install the extension

In Cursor, open the **Extensions** marketplace and search for **Pingy** or **cursorping**. Install the **Pingy** extension (publisher: `OwaisRafiq`).

### 2. Show the pairing QR code

Press `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`) to open the Command Palette, then run:

**Pingy: Show Pairing QR Code**

A window appears with your private topic (for example `pingy-xxxxxxx`) and a QR code.

> Important: run **Pingy: Run Setup (once for all agents and projects)** from the Command Palette. Nothing notifies until you do — this is what installs the hooks for Cursor and Claude Code.

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

Pingy is now connected to Cursor **and Claude Code**. Keep coding — you'll get mobile alerts when your agent finishes, waits for permission, or hits an error.

Running setup installs hooks for both agents at once (`~/.cursor/hooks.json` and `~/.claude/settings.json`), and both use the topic you just paired. Restart Claude Code so it picks up the new hooks, then run `/hooks` in Claude Code to confirm they're registered.

---

## Claude Code without the extension

If you use the Claude Code CLI and don't have the Pingy extension installed, wire it up by hand — it's three steps.

**1. Copy the hook scripts** from this repo's `hooks-template/` to `~/.claude/hooks/pingy/`:

```bash
git clone https://github.com/owaisrafiq05/Pingy-AI-Agent-Mobile-Notifier
mkdir -p ~/.claude/hooks/pingy
cp -r Pingy-AI-Agent-Mobile-Notifier/hooks-template/* ~/.claude/hooks/pingy/
```

**2. Create `~/.claude/hooks/pingy/cursorping.config.json`** with a private, unguessable topic (this is what you subscribe to in the ntfy app):

```json
{
  "ntfyTopic": "pingy-pick-something-random",
  "serverUrl": "https://ntfy.sh"
}
```

**3. Merge this into `~/.claude/settings.json`**, replacing `<ABS>` with the absolute path to `~/.claude/hooks/pingy` (use forward slashes, keep the quotes — paths often contain spaces). If the file already exists, add only the `hooks` key and leave your other settings alone:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"<ABS>/pingy-claude.js\" UserPromptSubmit", "timeout": 10 }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt|worker_permission_prompt|agent_needs_input|idle_prompt|elicitation_dialog|elicitation_url_dialog",
        "hooks": [{ "type": "command", "command": "node \"<ABS>/pingy-claude.js\" Notification", "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"<ABS>/pingy-claude.js\" Stop", "timeout": 10 }] }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "node \"<ABS>/pingy-claude.js\" StopFailure", "timeout": 10 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"<ABS>/pingy-claude.js\" SessionEnd", "timeout": 10 }] }
    ]
  }
}
```

Restart Claude Code, run `/hooks` to confirm all five are registered, then subscribe to your topic in the ntfy app. Requires Node 18+.

To test without waiting for a real task:

```bash
echo '{"session_id":"t1","cwd":"'"$PWD"'"}' | node ~/.claude/hooks/pingy/pingy-claude.js Stop
echo '{"session_id":"t1","cwd":"'"$PWD"'","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}' \
  | node ~/.claude/hooks/pingy/pingy-claude.js Notification
```

### How often Claude Code waiting alerts fire

Claude Code raises a notification for *every* approval dialog, and in `default`
permission mode a single turn opens one per tool call. Pingy sends one waiting
push per turn instead of one per dialog — enough to tell you to come back to your
terminal, without a buzz for every prompt. It re-arms when you send your next
prompt, when the turn ends, or after 5 minutes if the agent is still blocked. Set
`cursorping.waitingRepingMs` (extension settings) or `waitingRepingMs` in
`~/.claude/hooks/pingy/cursorping.config.json` to change that window.

---

## Why Pingy

1. **Waiting alerts** — get pinged when the agent is blocked on an "Allow?" prompt
2. **One-time setup** — install once, pair your phone once; every agent and every project notifies
3. **Session context** — every push includes the project name, the agent, and the prompt when available

### What you get on your phone

| Event | Title | Body |
|-------|-------|------|
| Completed | Completed | Your agent cooked. Task's done 🔥 |
| Waiting | 👀 Waiting | Hey, your agent needs you |
| Error | 🚨 Error | Uh oh… your agent hit a snag 😬 |

Each notification also includes **Project**, **Agent** (`Cursor` or `Claude Code`), and **Prompt** when available. On Claude Code the push also carries what the agent is waiting for (`Needs: Claude needs your permission to use Bash`) or what broke (`Error: rate_limit`).

### When Cursor waiting alerts fire

Cursor exposes no event for "approval prompt opened" — only events that fire
before a tool runs, whether or not you are asked. So Pingy alerts only when the
evidence actually points at a prompt:

- the gate is one Cursor prompts about (a shell command or an MCP call — never a
  read, search or edit, which Cursor applies itself)
- it has stayed open longer than `cursorping.waitingAfterMs` (default 45s), which
  is well past any ordinary auto-run tool call
- and either terminal activity confirms nothing is running, or you are not at the
  Cursor window

That means a command Cursor auto-ran never pings you, at the cost of occasionally
missing a real prompt. Two knobs if you want it tuned differently:
`cursorping.waitingAfterMs` to change the patience, and
`cursorping.alertOnUnconfirmedShellWaits` to alert on shell waits that terminal
activity cannot confirm (useful if you never use auto-run).

## Supported agents

| | Agent | Status |
|---|-------|--------|
| <img src="media/logos/cursor.png" alt="Cursor" width="22" height="22" /> | **Cursor** | Supported now |
| <img src="media/logos/claude.png" alt="Claude" width="22" height="22" /> | **Claude Code** | Supported now |
| <img src="media/logos/openai.png" alt="Codex" width="22" height="22" /> | **Codex** | Coming soon |
| | More | Coming soon |

One setup covers both agents, and both publish to the same topic — you pair your phone once.

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
