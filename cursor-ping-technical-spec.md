# CursorPing — Technical Specification (v2)
### A VS Code/Cursor extension + hook bridge that pushes a mobile notification when the Cursor Agent finishes or needs input

Version 0.2 · Built on Cursor's official Hooks API (v1.7+) · Target: buildable in a weekend · License: MIT (open source)

---

## 1. What changed from v1 of this spec

The first version of this doc assumed Cursor had no official way to detect agent completion, and designed a heuristic file/terminal-watching detector to work around that. That assumption was outdated: **Cursor shipped an official Hooks system in v1.7 (October 2025)**, with a documented `stop` lifecycle event that fires reliably with a `status` field (`completed` / `aborted` / `error`). Official docs: https://cursor.com/docs/agent/hooks

This rewrite discards the heuristic detector entirely and builds on the real hook event. It's simpler, more reliable, and matches how Claude Code's hooks work — good, because it means one mental model covers both of your target agents later if you ever want to expand.

**Prior art already exists and should be treated as reference material, not a starting point to fork.** Study these, then build independently:
- https://github.com/beautyfree/cursor-ntfy-on-stop-hook — minimal `stop` hook → ntfy, closest existing analog to this idea
- https://github.com/DevinoSolutions/ai-agent-notifier — broader multi-agent notifier (Claude Code, Codex, Gemini CLI, Cursor) with toast + ntfy + webhooks + terminal bell
- https://github.com/hgbdev/cursor-agent-notifier — older macOS-only bash approach, predates Cursor's native hooks
- https://blog.gitbutler.com/cursor-hooks-deep-dive — good technical walkthrough of the hooks payload shape
- https://cursor.com/docs/agent/hooks — canonical spec, treat as source of truth over any blog post if they disagree

---

## 2. Where This Product Differentiates

Given #1's existing solutions already cover "stop event → ntfy," a from-scratch build only makes sense if it goes further. Target these three differentiators for v1:

1. **Real "needs approval" alerts, not just "finished."** Existing tools mostly notify on `stop`. Cursor's hooks also expose `beforeShellExecution` and `beforeMCPExecution` — events that fire *before* a command runs and can require approval. Detecting a stall between "hook fired" and "no corresponding follow-up within N seconds" gives a genuine "Cursor is waiting on you" push, which is more valuable than a completion ping and is not well covered by the reference projects above.
2. **A real VS Code/Cursor extension for setup, not a manual `hooks.json` edit.** The prior art is CLI-installed hook scripts. A proper extension gives you: a setup wizard, auto-generated ntfy topic with QR code to scan on your phone, a status bar indicator, and a "send test notification" command — the onboarding experience is the actual product improvement here.
3. **Session context in the notification.** Cursor's `stop` payload includes `conversation_id`, `status`, and `workspace_roots`. Use `workspace_roots` to name the project in the push ("Cursor finished — checkout-api") instead of a generic message, and surface `status: "error"` or `"aborted"` distinctly from `"completed"` so a failed run doesn't look like a success.

---

## 3. High-Level Architecture

```
┌────────────────────────────────────────────────────────────┐
│                         Cursor Agent                         │
│                                                                │
│   Lifecycle events (official, documented):                    │
│   beforeShellExecution → afterFileEdit → ... → stop            │
└───────────────────────────┬────────────────────────────────┘
                             │ spawns hook process, JSON via stdin
                             ▼
                 ┌───────────────────────┐
                 │   Hook Bridge (Node)    │   .cursor/hooks/*.js
                 │  - reads stdin JSON      │
                 │  - classifies event       │
                 │  - tracks pending-approval │
                 │    state in a local file   │
                 │  - calls Notifier module    │
                 └───────────┬───────────────┘
                             │ HTTPS POST
                             ▼
                   ┌───────────────────┐
                   │  ntfy.sh (or        │
                   │  self-hosted)        │
                   └─────────┬─────────────┘
                             │ push
                             ▼
                   ┌───────────────────┐
                   │  ntfy mobile app    │
                   │  (iOS / Android)     │
                   └───────────────────┘

┌────────────────────────────────────────────────────────────┐
│         VS Code/Cursor Extension (companion, optional          │
│         but recommended — this is the differentiator)          │
│                                                                  │
│  - Setup wizard: generates ntfy topic, writes .cursor/hooks.json │
│    and drops the hook script into .cursor/hooks/                 │
│  - Status bar item: shows last known agent state                  │
│  - Command: "CursorPing: Send Test Notification"                   │
│  - Command: "CursorPing: Show Pairing QR Code"                      │
└────────────────────────────────────────────────────────────┘
```

Two moving pieces, deliberately decoupled:
- The **hook bridge** is a plain Node script Cursor invokes directly — it works even without the extension installed, as long as `hooks.json` points to it. This is what actually talks to ntfy.
- The **extension** is a convenience layer: it writes the hook config for the user and gives them a UI, but the notification pipeline doesn't depend on the extension being active. This separation matters because Cursor hooks run as external processes outside the extension host — don't try to make the extension itself receive the hook events directly, it can't.

---

## 4. Cursor Hooks — What You're Actually Building Against

### 4.1 Config location

- Project-level: `.cursor/hooks.json` (checked into repo, team-shared)
- User-level (global): `~/.cursor/hooks.json` (applies to every workspace)

Build for project-level first (simpler to test), document the global path as an option in the README.

### 4.2 Config shape

```jsonc
// .cursor/hooks.json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      { "command": "node .cursor/hooks/cursorping.js beforeShellExecution" }
    ],
    "stop": [
      { "command": "node .cursor/hooks/cursorping.js stop" }
    ]
  }
}
```

### 4.3 Payload shape (from official docs / GitButler's writeup — verify exact fields against https://cursor.com/docs/agent/hooks before finalizing, this evolves)

`stop` event payload (confirmed field set):
```json
{
  "conversation_id": "cdefee2d-2727-4b73-bf77-d9d830f31d2a",
  "generation_id": "26b45fb6-bdea-439c-b2dc-5e97ee00ecea",
  "status": "completed",
  "hook_event_name": "stop",
  "workspace_roots": ["/Users/you/projects/checkout-api"]
}
```
`status` is one of `"completed"`, `"aborted"`, `"error"` — use this to differentiate notification tone/priority.

`beforeShellExecution` fires before a command runs and can itself be used to allow/deny/modify the command (that's its primary purpose in Cursor's design). For this product, you're not blocking anything — you're using its *timing* as a signal: if it fires and a reasonable window passes with no subsequent hook event, the agent is plausibly blocked on an approval UI.

### 4.4 Hook process contract

- Cursor spawns your command as a child process and pipes JSON to stdin.
- Exit code and stdout/stderr matter for hooks that gate behavior (like `beforeShellExecution` returning an allow/deny decision). For this product you generally want to **allow everything** (don't interfere with the agent) and just observe — return a neutral/allow response promptly so you never introduce latency or breakage into the user's actual agent loop. This is important: a bug in your hook script should never be able to block the user's real work.
- Keep the hook script fast (it runs synchronously in the agent's path for the blocking event types) — do the ntfy POST with a short timeout and don't let a network hiccup hang the agent.

---

## 5. "Needs Approval" Detection Design (the actual differentiator)

```
beforeShellExecution fires
   → write { conversationId, ts: now() } to a small local state file
        (.cursor/hooks/state/pending.json)
   → schedule nothing yet (hook process exits immediately, must be fast)

Separate lightweight watcher (see §5.1) checks:
   → if a pending entry is older than PENDING_TIMEOUT_MS (e.g. 15s)
     AND no afterFileEdit/stop event has cleared it
   → fire "Cursor may need your approval" notification, priority=high

afterFileEdit or stop fires
   → clear the pending entry for that conversationId
```

### 5.1 Implementing the watcher without a long-running process

Hook scripts are short-lived — they can't just `setInterval` and wait, since Cursor spawns and expects them to exit. Two workable approaches, pick one for v1:

**Option A (simpler, recommended for the weekend):** Each hook invocation checks the state file for *stale* pending entries (older than the timeout) before doing anything else, and fires the "needs approval" notification itself if it finds one — piggybacking on whatever hook happens to run next. This has a weakness: if nothing else fires after a stall, nothing checks. Mitigate by also checking staleness inside the `stop` hook itself and, if this proves insufficient in testing, add Option B.

**Option B (more robust, stretch goal):** The VS Code extension runs a `setInterval` timer (it's a long-lived process, unlike hook scripts) that periodically reads the same state file and fires the notification if a pending entry goes stale. This is the reason the companion extension is worth building — it can do things a spawned hook process fundamentally cannot.

Document this trade-off in the README so contributors understand why the extension isn't just a config generator.

---

## 6. Mobile Notification Pipeline

- **ntfy.sh**, open source, no signup, `POST https://ntfy.sh/<topic>`.
- Generate a random, unguessable topic on first setup (`crypto.randomUUID()`), never let the user pick something guessable like `cursor-notifications`.
- Expose a `serverUrl` config option for self-hosted ntfy instances.

```javascript
// .cursor/hooks/lib/notifier.js
async function sendNotification(topic, { title, message, priority = 'default', tags = [] }, serverUrl = 'https://ntfy.sh') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // never hang the agent
  try {
    await fetch(`${serverUrl}/${topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: tags.join(',') },
      body: message,
      signal: controller.signal,
    });
  } catch (e) {
    // fail silently from the agent's perspective — never throw out of a hook
    console.error('cursorping: notify failed', e);
  } finally {
    clearTimeout(timeout);
  }
}
module.exports = { sendNotification };
```

Message design, using the richer payload now available:

| Event | Title | Body | Priority | Tag |
|---|---|---|---|---|
| `stop`, status `completed` | "Cursor finished — {project}" | e.g. summarized from `workspace_roots` | default | white_check_mark |
| `stop`, status `error` | "Cursor hit an error — {project}" | "Session ended with an error." | high | x |
| `stop`, status `aborted` | "Cursor session aborted — {project}" | "You (or something) stopped the session." | low | no_entry_sign |
| stale `beforeShellExecution` | "Cursor needs you — {project}" | "Waiting on a command approval." | urgent | warning |

---

## 7. Repo Structure (built from scratch)

```
cursorping/
├── package.json                # extension manifest
├── tsconfig.json
├── README.md
├── LICENSE                     # MIT
├── CHANGELOG.md
├── src/                        # VS Code/Cursor extension
│   ├── extension.ts             # activation, commands, status bar
│   ├── setupWizard.ts            # writes .cursor/hooks.json + hook scripts into workspace
│   ├── pairing.ts                 # generates topic, QR code (use a small QR lib)
│   ├── statusBar.ts
│   └── config.ts
├── hooks-template/              # files copied into the user's .cursor/hooks/ by the wizard
│   ├── cursorping.js              # the actual hook entrypoint, dispatches by event name
│   └── lib/
│       ├── notifier.js
│       └── state.js               # pending-approval state file read/write
└── media/
    └── icon.png
```

### 7.1 `hooks-template/cursorping.js` — dispatcher skeleton

```javascript
#!/usr/bin/env node
const { sendNotification } = require('./lib/notifier');
const { markPending, clearPending, findStalePending } = require('./lib/state');
const config = require('./cursorping.config.json'); // written by the setup wizard

async function main() {
  const eventName = process.argv[2]; // passed via hooks.json command args
  const raw = await readStdin();
  const payload = JSON.parse(raw || '{}');

  switch (eventName) {
    case 'beforeShellExecution':
      markPending(payload.conversation_id);
      break;

    case 'afterFileEdit':
      clearPending(payload.conversation_id);
      break;

    case 'stop': {
      clearPending(payload.conversation_id);
      const project = (payload.workspace_roots?.[0] ?? '').split('/').pop() || 'project';
      const messages = {
        completed: { title: `Cursor finished — ${project}`, priority: 'default', tags: ['white_check_mark'] },
        error:     { title: `Cursor hit an error — ${project}`, priority: 'high', tags: ['x'] },
        aborted:   { title: `Cursor session aborted — ${project}`, priority: 'low', tags: ['no_entry_sign'] },
      };
      const m = messages[payload.status] ?? messages.completed;
      await sendNotification(config.ntfyTopic, { ...m, message: `Status: ${payload.status}` }, config.serverUrl);
      break;
    }
  }

  // Always check for staleness as a fallback catch-all (see §5.1 Option A)
  const stale = findStalePending(config.pendingTimeoutMs ?? 15000);
  for (const conv of stale) {
    await sendNotification(config.ntfyTopic, {
      title: 'Cursor needs you',
      message: 'Waiting on a command approval.',
      priority: 'urgent',
      tags: ['warning'],
    }, config.serverUrl);
    clearPending(conv); // avoid re-notifying every subsequent hook call
  }

  process.exit(0); // exit fast, never hang Cursor's agent loop
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000); // safety timeout
  });
}

main();
```

### 7.2 `src/setupWizard.ts` — what the extension actually does

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export async function runSetupWizard(workspaceRoot: string) {
  const topic = `cursorping-${randomUUID().slice(0, 8)}`;
  const hooksDir = path.join(workspaceRoot, '.cursor', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // copy hooks-template/* into hooksDir (bundled with the extension)
  copyTemplateFiles(hooksDir);

  fs.writeFileSync(
    path.join(hooksDir, 'cursorping.config.json'),
    JSON.stringify({ ntfyTopic: topic, serverUrl: 'https://ntfy.sh', pendingTimeoutMs: 15000 }, null, 2)
  );

  const hooksJsonPath = path.join(workspaceRoot, '.cursor', 'hooks.json');
  const hooksConfig = {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: 'node .cursor/hooks/cursorping.js beforeShellExecution' }],
      afterFileEdit: [{ command: 'node .cursor/hooks/cursorping.js afterFileEdit' }],
      stop: [{ command: 'node .cursor/hooks/cursorping.js stop' }],
    },
  };
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2));

  vscode.window.showInformationMessage(
    `CursorPing set up. Subscribe to topic "${topic}" in the ntfy app to receive notifications.`
  );
}
```

The extension's job is entirely file-generation and UX — it never intercepts hook events itself (see §3). Keep this boundary clean.

---

## 8. Publishing

- Cursor installs extensions from the **Open VSX Registry**, not the Microsoft Marketplace. Publish to both (`vsce publish` and `ovsx publish`).
- Prior art in this space (see beautyfree's repo) is distributed via `npx cursor-hook install <repo>`, a community installer for hooks-only projects. Since you're shipping a full extension plus hook templates, the extension marketplace listing is your primary distribution channel — but consider also making the `hooks-template/` directory work as a standalone `cursor-hook install`-compatible package for people who don't want the full extension. That's a nice stretch goal, not required for v1.

---

## 9. Weekend Build Plan

**Day 1 — hook bridge working standalone (no extension yet)**
1. Manually create `.cursor/hooks.json` + `.cursor/hooks/cursorping.js` in a scratch test repo.
2. Implement `notifier.js`, hardcode a test ntfy topic, confirm a phone notification arrives on a manual `stop` hook test invocation (`echo '...' | node cursorping.js stop`).
3. Wire the real `stop` event in Cursor, trigger an actual agent task, confirm the notification fires with correct `status`.
4. Add `beforeShellExecution` + `afterFileEdit` handlers and the pending-state file logic; test the "needs approval" path by giving the agent a task that requires shell approval.

**Day 2 — extension wrapper + polish**
5. Scaffold the VS Code extension (`yo code`), implement `setupWizard.ts` to generate the files from Day 1 automatically.
6. Add the pairing UX: show the topic, generate a QR code (small npm QR lib) for fast phone subscription.
7. Add status bar item and `CursorPing: Send Test Notification` command.
8. Implement Option B watcher (extension-side interval check) if time allows — this is the genuine differentiator from existing tools.
9. Write README: setup instructions, the differentiation from prior art (link the repos from §1), honest limitations (§10).
10. Package `.vsix`, test clean install in a fresh Cursor profile.
11. Push to GitHub, MIT license, tag v0.1.0.

---

## 10. Known Limitations to Document Publicly

- Hooks are still a relatively new Cursor feature (introduced v1.7) — field names and behavior may shift; pin against https://cursor.com/docs/agent/hooks and note the Cursor version you tested against in the README.
- The "needs approval" detection is a timing heuristic layered on top of real events, not a first-class Cursor signal — a slow-but-legitimate shell command can still produce a false "needs you" alert. Make `pendingTimeoutMs` configurable.
- ntfy topics are public-by-obscurity; document self-hosting for anyone security-sensitive.
- Hooks currently apply to the Cursor IDE agent; Cursor's CLI agent has an open feature request for hooks support as of early 2026 — don't promise CLI support in the README until confirmed.

---

## 11. Reference Links (prior art and source docs — study, don't copy)

- https://cursor.com/docs/agent/hooks — official hooks spec, source of truth
- https://github.com/beautyfree/cursor-ntfy-on-stop-hook — closest existing tool
- https://github.com/DevinoSolutions/ai-agent-notifier — multi-agent notifier including Cursor
- https://github.com/hgbdev/cursor-agent-notifier — older macOS-only approach, pre-hooks era
- https://blog.gitbutler.com/cursor-hooks-deep-dive — practical walkthrough of hook payloads and use cases
- https://forum.cursor.com/t/push-notifications-mobile-desktop-when-agent-needs-user-input-or-approval/148230 — community demand thread for the exact "needs approval" feature this spec targets
