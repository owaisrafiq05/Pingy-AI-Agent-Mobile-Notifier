#!/usr/bin/env node
/**
 * CursorPing hook entrypoint.
 * Cursor spawns: node ./hooks/cursorping.js <eventName>
 * Payload JSON is piped on stdin.
 *
 * Observe-only: always exit 0 and never block the agent.
 */
const path = require('path');
const { sendNotification } = require('./lib/notifier');
const { stopMessage, needsYouMessage } = require('./lib/messages');
const {
  rememberPrompt,
  resolveChatContext,
} = require('./lib/context');
const {
  markPending,
  clearPending,
  findStalePending,
  markNotified,
} = require('./lib/state');

function loadConfig() {
  try {
    return require('./cursorping.config.json');
  } catch {
    return {
      ntfyTopic: '',
      serverUrl: 'https://ntfy.sh',
      pendingTimeoutMs: 15000,
    };
  }
}

function projectName(workspaceRoots) {
  const root = workspaceRoots?.[0] ?? '';
  if (!root) return 'project';
  return path.basename(root.replace(/[/\\]+$/, '')) || 'project';
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

async function notifyStale(config, project, payload) {
  const stale = findStalePending(config.pendingTimeoutMs ?? 15000);
  for (const conv of stale) {
    const chat = resolveChatContext({
      conversation_id: conv,
      transcript_path: payload?.transcript_path,
    });
    await sendNotification(
      config.ntfyTopic,
      needsYouMessage(project, chat),
      config.serverUrl
    );
    markNotified(conv);
    clearPending(conv);
  }
}

async function main() {
  const eventName = process.argv[2] || '';
  const config = loadConfig();
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    console.error('cursorping: invalid JSON on stdin', e);
  }

  const project = projectName(payload.workspace_roots);

  try {
    switch (eventName) {
      case 'beforeSubmitPrompt': {
        // Capture what the user asked so stop notifications have context
        rememberPrompt(payload.conversation_id, payload.prompt);
        process.stdout.write(JSON.stringify({ continue: true }));
        break;
      }

      case 'beforeShellExecution':
        markPending(payload.conversation_id);
        process.stdout.write(JSON.stringify({ permission: 'allow' }));
        break;

      case 'afterFileEdit':
        clearPending(payload.conversation_id);
        break;

      case 'stop': {
        clearPending(payload.conversation_id);
        const chat = resolveChatContext(payload);
        await sendNotification(
          config.ntfyTopic,
          stopMessage(payload.status, project, chat),
          config.serverUrl
        );
        break;
      }

      default:
        break;
    }

    await notifyStale(config, project, payload);
  } catch (e) {
    console.error('cursorping: unexpected error', e);
  }

  process.exit(0);
}

main();
