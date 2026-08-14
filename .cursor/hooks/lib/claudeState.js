/**
 * Per-session bookkeeping for the Claude Code hook entrypoint.
 *
 * Claude Code fires one `Notification` per dialog that blocks the agent. In
 * `default` permission mode a single turn opens a dozen of them, and a push for
 * each turns Pingy into a spam machine — measured: 23 "Waiting" pushes in 16
 * minutes of ordinary work. A waiting push means "come back to your terminal",
 * so one per turn is the whole useful signal; the rest repeat what the user
 * already knows. `repingMs` re-opens the gate for turns long enough that the
 * user has plausibly wandered off again.
 *
 * The same state also keeps `idle_prompt` honest. Claude Code emits it 60s after
 * a turn ends ("Claude is waiting for your input"), which is the state we just
 * pushed a *completion* for — pushing "your agent needs you" on top of "task's
 * done" is worse than silence.
 *
 * Everything here is pure except `readSessions`/`writeSessions`, so the decision
 * rules are unit-testable without spawning a hook.
 */
const fs = require('fs');
const path = require('path');

/** Waiting pushes for one session collapse into one until this much has passed. */
const DEFAULT_REPING_MS = 5 * 60 * 1000;

/**
 * `Stop` can fire twice for one turn when another Stop hook forces the agent to
 * continue (`stop_hook_active`), and the harness may re-run it after background
 * work wakes the session. Identical stops this close together are one event.
 */
const STOP_DEDUPE_MS = 10_000;

/** Sessions older than this are dead — Claude Code was restarted or ended. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Turn sources the machine drives itself. `/loop` and scheduled wake-ups end a
 * turn on every tick; a completion push per tick is noise the user never asked
 * for. They still get waiting pushes — a blocked loop needs a human either way.
 */
const MACHINE_TURN_SOURCES = new Set(['loop_wakeup', 'schedule_wakeup']);

function emptyEntry(now) {
  return {
    turnAt: null,
    turnSource: null,
    waitingAt: null,
    stopAt: null,
    stopSig: null,
    updatedAt: now,
  };
}

function readSessions(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Write via a temp file + rename so a hook killed mid-write cannot leave torn
 * JSON behind — a corrupt state file would silently disable every decision here.
 */
function writeSessions(file, sessions) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    // Best effort: a failed write must never suppress the notification itself.
    return false;
  }
}

function pruneSessions(sessions, now, ttlMs = SESSION_TTL_MS) {
  for (const [id, entry] of Object.entries(sessions)) {
    const stamp = entry && typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
    if (!stamp || now - stamp > ttlMs) {
      delete sessions[id];
    }
  }
  return sessions;
}

function entryFor(sessions, sessionId, now) {
  if (!sessions[sessionId] || typeof sessions[sessionId] !== 'object') {
    sessions[sessionId] = emptyEntry(now);
  }
  return sessions[sessionId];
}

/**
 * A new turn started. Both flags reset: the user is demonstrably at the keyboard,
 * so the next block is a fresh interruption worth a push.
 */
function noteTurnStart(sessions, sessionId, { now = Date.now(), source = null } = {}) {
  if (!sessionId) return sessions;
  const entry = entryFor(sessions, sessionId, now);
  entry.turnAt = now;
  entry.turnSource = source || null;
  entry.waitingAt = null;
  entry.stopAt = null;
  entry.stopSig = null;
  entry.updatedAt = now;
  return sessions;
}

/** True once a completion push covered the current turn. */
function turnIsOver(entry) {
  if (!entry || typeof entry.stopAt !== 'number') return false;
  if (typeof entry.turnAt !== 'number') return true;
  return entry.stopAt >= entry.turnAt;
}

/**
 * Decide whether this blocked-on-you notice earns a push, and claim it if so.
 *
 * @returns {boolean} true when the caller should send
 */
function claimWaiting(
  sessions,
  sessionId,
  { now = Date.now(), kind = null, repingMs = DEFAULT_REPING_MS } = {}
) {
  // No session id means no way to dedupe. Sending is the safer failure.
  if (!sessionId) return true;

  const entry = entryFor(sessions, sessionId, now);

  // "Claude is waiting for your input" 60s after a turn ended is the state the
  // completion push already reported.
  if (kind === 'idle_prompt' && turnIsOver(entry)) {
    entry.updatedAt = now;
    return false;
  }

  if (typeof entry.waitingAt === 'number' && now - entry.waitingAt < repingMs) {
    entry.updatedAt = now;
    return false;
  }

  entry.waitingAt = now;
  entry.updatedAt = now;
  return true;
}

/**
 * Decide whether this turn-end earns a push, and claim it if so.
 *
 * `signature` distinguishes a genuine second turn from the same turn stopping
 * twice; the last assistant message is the cheapest thing that differs.
 */
function claimStop(
  sessions,
  sessionId,
  { now = Date.now(), signature = '', dedupeMs = STOP_DEDUPE_MS } = {}
) {
  if (!sessionId) return true;

  const entry = entryFor(sessions, sessionId, now);

  if (
    typeof entry.stopAt === 'number' &&
    entry.stopSig === signature &&
    now - entry.stopAt < dedupeMs
  ) {
    entry.updatedAt = now;
    return false;
  }

  entry.stopAt = now;
  entry.stopSig = signature;
  // The turn is over, so whatever the user was needed for is resolved: let the
  // next turn's first block ping immediately instead of waiting out the cooldown.
  entry.waitingAt = null;
  entry.updatedAt = now;
  return true;
}

/** True when the current turn was started by the machine, not the user. */
function turnIsMachineDriven(sessions, sessionId) {
  const entry = sessions?.[sessionId];
  return !!entry && MACHINE_TURN_SOURCES.has(entry.turnSource);
}

function forgetSession(sessions, sessionId) {
  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
  }
  return sessions;
}

module.exports = {
  DEFAULT_REPING_MS,
  MACHINE_TURN_SOURCES,
  SESSION_TTL_MS,
  STOP_DEDUPE_MS,
  claimStop,
  claimWaiting,
  forgetSession,
  noteTurnStart,
  pruneSessions,
  readSessions,
  turnIsMachineDriven,
  turnIsOver,
  writeSessions,
};
