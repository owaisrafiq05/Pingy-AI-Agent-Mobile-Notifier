#!/usr/bin/env node
/**
 * CursorPing hook entrypoint.
 * Cursor spawns: node .cursor/hooks/cursorping.js <eventName>
 * Payload JSON is piped on stdin.
 *
 * Observe-only: always exit 0 and never block the agent.
 */
const path = require('path');
const { sendNotification } = require('./lib/notifier');
const { stopMessage, needsYouMessage } = require('./lib/messages');
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

async function notifyStale(config, project) {
  const stale = findStalePending(config.pendingTimeoutMs ?? 15000);
  for (const conv of stale) {
    await sendNotification(
      config.ntfyTopic,
      needsYouMessage(project),
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
      case 'beforeShellExecution':
        markPending(payload.conversation_id);
        // Allow everything - observe only
        process.stdout.write(JSON.stringify({ permission: 'allow' }));
        break;

      case 'afterFileEdit':
        clearPending(payload.conversation_id);
        break;

      case 'stop': {
        clearPending(payload.conversation_id);
        await sendNotification(
          config.ntfyTopic,
          stopMessage(payload.status, project),
          config.serverUrl
        );
        break;
      }

      default:
        break;
    }

    // Option A: piggyback stale-pending checks on every hook invocation
    await notifyStale(config, project);
  } catch (e) {
    console.error('cursorping: unexpected error', e);
  }

  process.exit(0);
}

main();
