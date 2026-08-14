const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_REPING_MS,
  claimStop,
  claimWaiting,
  forgetSession,
  noteTurnStart,
  pruneSessions,
  readSessions,
  turnIsMachineDriven,
  turnIsOver,
  writeSessions,
} = require('../hooks-template/lib/claudeState');

const SESSION = 'sess-1';

test('the first block of a turn always pings', () => {
  const sessions = noteTurnStart({}, SESSION, { now: 1000, source: 'user' });
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 2000, kind: 'permission_prompt' }),
    true
  );
});

test('later blocks in the same turn are one interruption, not many', () => {
  // The bug this file exists for: Claude Code raises a notification per approval
  // dialog, and `default` permission mode opens one per tool call.
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  const sent = [];
  for (const now of [1_000, 20_000, 60_000, 120_000, 200_000]) {
    sent.push(claimWaiting(sessions, SESSION, { now, kind: 'permission_prompt' }));
  }
  assert.deepStrictEqual(sent, [true, false, false, false, false]);
});

test('a long block pings again once the reping window passes', () => {
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 1_000, kind: 'permission_prompt' }),
    true
  );
  assert.strictEqual(
    claimWaiting(sessions, SESSION, {
      now: 1_000 + DEFAULT_REPING_MS,
      kind: 'permission_prompt',
    }),
    true
  );
});

test('a fresh prompt proves the user is back, so the next block pings', () => {
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  claimWaiting(sessions, SESSION, { now: 1_000, kind: 'permission_prompt' });
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 2_000, kind: 'permission_prompt' }),
    false
  );

  noteTurnStart(sessions, SESSION, { now: 3_000, source: 'user' });
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 4_000, kind: 'permission_prompt' }),
    true
  );
});

test('the 60s idle notice stays silent once the turn was reported done', () => {
  // Claude Code emits idle_prompt a minute after a turn ends. Pushing "your agent
  // needs you" on top of "task's done" is worse than saying nothing.
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  assert.strictEqual(claimStop(sessions, SESSION, { now: 10_000 }), true);
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 70_000, kind: 'idle_prompt' }),
    false
  );
});

test('an idle notice mid-turn is a real block and pings', () => {
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 60_000, kind: 'idle_prompt' }),
    true
  );
});

test('a turn that ends after a block lets the next turn ping immediately', () => {
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  claimWaiting(sessions, SESSION, { now: 1_000, kind: 'permission_prompt' });
  claimStop(sessions, SESSION, { now: 2_000, signature: 'Stop:done' });

  // Same session, no new prompt recorded (the user approved rather than typed).
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 3_000, kind: 'permission_prompt' }),
    true
  );
});

test('one turn stopping twice is one completion push', () => {
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  assert.strictEqual(
    claimStop(sessions, SESSION, { now: 1_000, signature: 'Stop:all done' }),
    true
  );
  assert.strictEqual(
    claimStop(sessions, SESSION, { now: 2_000, signature: 'Stop:all done' }),
    false,
    'stop_hook_active re-entry must not double-push'
  );
});

test('a genuinely different turn-end still pushes', () => {
  const sessions = noteTurnStart({}, SESSION, { now: 0, source: 'user' });
  assert.strictEqual(
    claimStop(sessions, SESSION, { now: 1_000, signature: 'Stop:first answer' }),
    true
  );
  assert.strictEqual(
    claimStop(sessions, SESSION, { now: 2_000, signature: 'Stop:second answer' }),
    true
  );
  // And the same text again later is a new turn, not a repeat.
  assert.strictEqual(
    claimStop(sessions, SESSION, { now: 120_000, signature: 'Stop:second answer' }),
    true
  );
});

test('machine-driven turns are recognised so they can stay quiet', () => {
  const sessions = {};
  noteTurnStart(sessions, 'loop', { now: 0, source: 'loop_wakeup' });
  noteTurnStart(sessions, 'cron', { now: 0, source: 'schedule_wakeup' });
  noteTurnStart(sessions, 'human', { now: 0, source: 'user' });
  noteTurnStart(sessions, 'headless', { now: 0, source: 'sdk' });
  noteTurnStart(sessions, 'unknown', { now: 0 });

  assert.strictEqual(turnIsMachineDriven(sessions, 'loop'), true);
  assert.strictEqual(turnIsMachineDriven(sessions, 'cron'), true);
  assert.strictEqual(turnIsMachineDriven(sessions, 'human'), false);
  assert.strictEqual(turnIsMachineDriven(sessions, 'headless'), false);
  assert.strictEqual(turnIsMachineDriven(sessions, 'unknown'), false);
  assert.strictEqual(turnIsMachineDriven(sessions, 'never-seen'), false);
});

test('a session with no id is never deduped away', () => {
  const sessions = {};
  assert.strictEqual(
    claimWaiting(sessions, '', { now: 0, kind: 'permission_prompt' }),
    true
  );
  assert.strictEqual(
    claimWaiting(sessions, '', { now: 1, kind: 'permission_prompt' }),
    true
  );
  assert.strictEqual(claimStop(sessions, '', { now: 1 }), true);
  assert.deepStrictEqual(sessions, {}, 'nothing to key on means nothing to store');
});

test('turnIsOver only counts a stop that belongs to the current turn', () => {
  assert.strictEqual(turnIsOver(undefined), false);
  assert.strictEqual(turnIsOver({ turnAt: 100, stopAt: null }), false);
  assert.strictEqual(turnIsOver({ turnAt: 100, stopAt: 200 }), true);
  // A stop from the previous turn does not cover the one that just started.
  assert.strictEqual(turnIsOver({ turnAt: 300, stopAt: 200 }), false);
  assert.strictEqual(turnIsOver({ turnAt: null, stopAt: 200 }), true);
});

test('stale sessions are pruned and live ones survive', () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const sessions = {
    fresh: { updatedAt: now - 1_000 },
    old: { updatedAt: now - 25 * 60 * 60 * 1000 },
    broken: { updatedAt: 'nope' },
    empty: {},
  };
  pruneSessions(sessions, now);
  assert.deepStrictEqual(Object.keys(sessions), ['fresh']);
});

test('SessionEnd forgets just that session', () => {
  const sessions = { a: { updatedAt: 1 }, b: { updatedAt: 1 } };
  forgetSession(sessions, 'a');
  forgetSession(sessions, 'missing');
  assert.deepStrictEqual(Object.keys(sessions), ['b']);
});

test('state survives a missing, corrupt or hostile file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingy-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'claude-sessions.json');

  assert.deepStrictEqual(readSessions(file), {}, 'missing file reads as empty');

  assert.strictEqual(writeSessions(file, { a: { updatedAt: 1 } }), true);
  assert.deepStrictEqual(readSessions(file), { a: { updatedAt: 1 } });

  fs.writeFileSync(file, '{"a": ', 'utf8');
  assert.deepStrictEqual(readSessions(file), {}, 'half-written JSON reads as empty');

  fs.writeFileSync(file, '[1,2,3]', 'utf8');
  assert.deepStrictEqual(readSessions(file), {}, 'an array is not a session map');

  // A corrupt file must not wedge the state machine either.
  const sessions = readSessions(file);
  assert.strictEqual(
    claimWaiting(sessions, SESSION, { now: 1, kind: 'permission_prompt' }),
    true
  );
});

test('a claim on a corrupt entry replaces it instead of throwing', () => {
  for (const bad of [null, 'string', 42, []]) {
    const sessions = { [SESSION]: bad };
    assert.strictEqual(
      claimWaiting(sessions, SESSION, { now: 1, kind: 'permission_prompt' }),
      true
    );
    assert.strictEqual(typeof sessions[SESSION].waitingAt, 'number');
  }
});
