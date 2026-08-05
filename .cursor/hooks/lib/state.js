const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Prefer an explicit override (tests), otherwise the shared user-level state
 * dir so project + global CursorPing hooks claim the same pending map.
 */
const STATE_DIR =
  process.env.CURSORPING_STATE_DIR ||
  path.join(os.homedir(), '.cursor', 'hooks', 'state');
const STATE_FILE = path.join(STATE_DIR, 'pending.json');

/** Entries this old are abandoned (agent crashed, Cursor restarted, etc.). */
const MAX_AGE_MS = 30 * 60 * 1000;

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

/**
 * Several hook processes can run back-to-back, so write via a temp file and
 * rename to keep readers from ever seeing a half-written document.
 */
function writeState(state) {
  ensureStateDir();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

function dropAbandoned(state, now = Date.now()) {
  let changed = false;
  for (const [id, entry] of Object.entries(state)) {
    if (!entry || typeof entry.ts !== 'number' || now - entry.ts > MAX_AGE_MS) {
      delete state[id];
      changed = true;
    }
  }
  return changed;
}

/**
 * Record that the agent reached a gate where Cursor may ask the user to
 * approve something. One entry per conversation: the agent loop blocks on a
 * single gate at a time, and any later event proves it moved on.
 */
function markPending(conversationId, meta = {}) {
  if (!conversationId) return;
  const state = readState();
  dropAbandoned(state);
  state[conversationId] = {
    ts: Date.now(),
    notified: false,
    event: meta.event ?? null,
    toolName: meta.toolName ?? null,
    command: meta.command ?? null,
    toolUseId: meta.toolUseId ?? null,
  };
  writeState(state);
}

/**
 * The gate resolved — approved, rejected, or never shown at all. Clearing here
 * is what re-arms notifications for the next permission request.
 */
function clearPending(conversationId) {
  if (!conversationId) return;
  const state = readState();
  const had = Boolean(state[conversationId]);
  if (had) {
    delete state[conversationId];
  }
  if (had || dropAbandoned(state)) {
    writeState(state);
  }
}

/**
 * Atomically claim the right to send the one permission notification for this
 * gate. Returns true only for the first caller (hook timer or extension poll).
 */
function claimNotification(conversationId) {
  if (!conversationId) return false;
  const state = readState();
  const entry = state[conversationId];
  if (!entry || typeof entry.ts !== 'number' || entry.notified) {
    return false;
  }
  entry.notified = true;
  writeState(state);
  return true;
}

module.exports = {
  markPending,
  clearPending,
  claimNotification,
  readState,
  MAX_AGE_MS,
  STATE_FILE,
};
