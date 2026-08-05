#!/usr/bin/env node
/**
 * Detached follow-up after a gate opens. The parent hook must exit immediately,
 * so this short-lived process waits briefly and then notifies only if the gate
 * is still open — i.e. Cursor is still showing Run / Skip.
 *
 * Usage: node permissionCheck.js <delayMs> <conversationId>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sendNotification } = require('./notifier');
const { permissionMessage } = require('./messages');
const { readState, claimNotification } = require('./state');

function loadConfig() {
  const candidates = [];
  if (process.env.CURSORPING_CONFIG) {
    candidates.push(process.env.CURSORPING_CONFIG);
  }
  if (process.env.CURSORPING_STATE_DIR) {
    candidates.push(
      path.join(process.env.CURSORPING_STATE_DIR, '..', 'cursorping.config.json')
    );
  }
  candidates.push(
    path.join(os.homedir(), '.cursor', 'hooks', 'cursorping.config.json'),
    path.join(__dirname, '..', 'cursorping.config.json')
  );
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      if (cfg?.ntfyTopic) {
        return {
          ntfyTopic: cfg.ntfyTopic,
          serverUrl: cfg.serverUrl || 'https://ntfy.sh',
          pendingTimeoutMs: cfg.pendingTimeoutMs ?? 2000,
        };
      }
    } catch {
      /* try next */
    }
  }
  return {
    ntfyTopic: '',
    serverUrl: 'https://ntfy.sh',
    pendingTimeoutMs: 2000,
  };
}

async function main() {
  const delayMs = Math.max(0, Number(process.argv[2]) || 2000);
  const conversationId = process.argv[3] || '';
  if (!conversationId) {
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const entry = readState()[conversationId];
  if (!entry || entry.notified) {
    process.exit(0);
  }

  // Still open after the delay ⇒ the agent is waiting on the Allow prompt.
  if (!claimNotification(conversationId)) {
    process.exit(0);
  }

  const config = loadConfig();
  await sendNotification(
    config.ntfyTopic,
    permissionMessage(),
    config.serverUrl
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('cursorping: permissionCheck failed', e);
  process.exit(0);
});
