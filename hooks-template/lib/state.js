const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state');
const STATE_FILE = path.join(STATE_DIR, 'pending.json');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Record that a beforeShellExecution fired and may be waiting on approval.
 */
function markPending(conversationId) {
  if (!conversationId) return;
  const state = readState();
  state[conversationId] = { ts: Date.now(), notified: false };
  writeState(state);
}

/**
 * Clear pending entry after afterFileEdit / stop / approval notification.
 */
function clearPending(conversationId) {
  if (!conversationId) return;
  const state = readState();
  if (state[conversationId]) {
    delete state[conversationId];
    writeState(state);
  }
}

/**
 * Return conversation IDs whose pending entries are older than timeoutMs
 * and have not already been notified.
 */
function findStalePending(timeoutMs = 15000) {
  const state = readState();
  const now = Date.now();
  const stale = [];

  for (const [id, entry] of Object.entries(state)) {
    if (!entry || typeof entry.ts !== 'number') continue;
    if (entry.notified) continue;
    if (now - entry.ts >= timeoutMs) {
      stale.push(id);
    }
  }

  return stale;
}

/**
 * Mark a pending entry as already notified (Option A / B dedupe).
 */
function markNotified(conversationId) {
  if (!conversationId) return;
  const state = readState();
  if (state[conversationId]) {
    state[conversationId].notified = true;
    writeState(state);
  }
}

module.exports = {
  markPending,
  clearPending,
  findStalePending,
  markNotified,
  readState,
  STATE_FILE,
};
