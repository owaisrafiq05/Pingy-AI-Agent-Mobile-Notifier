const test = require('node:test');
const assert = require('node:assert');

const {
  decidePending,
  applyDecision,
  parsePendingState,
  hasNotifiedPending,
} = require('../out/pendingState');

const TIMEOUT = 15000;
const MAX_AGE = 30 * 60 * 1000;

function gate(overrides = {}) {
  return { ts: 0, notified: false, toolName: 'Shell', command: 'npm test', ...overrides };
}

function decide(state, now, isExecuting) {
  return decidePending(state, {
    now,
    timeoutMs: TIMEOUT,
    maxAgeMs: MAX_AGE,
    isExecuting,
  });
}

/**
 * Simulates the extension watcher polling the file the hooks write, so the
 * assertions below count real would-be notifications.
 */
function runWatcher(state, { from, to, stepMs = 5000, isExecuting } = {}) {
  let sent = 0;
  for (let now = from; now <= to; now += stepMs) {
    const decision = decide(state, now, isExecuting);
    sent += decision.notify.length;
    applyDecision(state, decision);
  }
  return sent;
}

test('stays quiet while a gate resolves quickly', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const sent = runWatcher(state, { from: 0, to: 10000 });
  assert.strictEqual(sent, 0);
});

test('notifies once when a gate stays open past the timeout', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const decision = decide(state, TIMEOUT, undefined);
  assert.deepStrictEqual(decision.notify, ['conv1']);
});

test('never notifies twice while the prompt stays open', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const sent = runWatcher(state, { from: 0, to: 5 * 60 * 1000 });
  assert.strictEqual(sent, 1, 'a prompt left open for five minutes must ping once');
  assert.ok(hasNotifiedPending(state));
});

test('re-arms for the next request after the user approves', () => {
  const state = { conv1: gate({ ts: 0 }) };
  let sent = runWatcher(state, { from: 0, to: 60000 });
  assert.strictEqual(sent, 1);

  // Approval: the tool runs and postToolUse clears the entry.
  delete state.conv1;
  sent += runWatcher(state, { from: 60000, to: 90000 });
  assert.strictEqual(sent, 1, 'clearing the gate must not itself notify');

  // Next permission request in the same conversation.
  state.conv1 = gate({ ts: 100000 });
  sent += runWatcher(state, { from: 100000, to: 160000 });
  assert.strictEqual(sent, 2, 'the following request gets its own notification');
});

test('re-arms after the user rejects', () => {
  const state = { conv1: gate({ ts: 0 }) };
  assert.strictEqual(runWatcher(state, { from: 0, to: 60000 }), 1);

  // Rejection: postToolUseFailure(permission_denied) clears the entry.
  delete state.conv1;
  state.conv1 = gate({ ts: 70000 });
  assert.strictEqual(runWatcher(state, { from: 70000, to: 130000 }), 1);
});

test('tracks each conversation independently', () => {
  const state = { conv1: gate({ ts: 0 }), conv2: gate({ ts: 0 }) };
  const sent = runWatcher(state, { from: 0, to: 60000 });
  assert.strictEqual(sent, 2);
});

test('stays quiet while the command is actually executing', () => {
  const state = { conv1: gate({ ts: 0, command: 'npm install' }) };
  const sent = runWatcher(state, {
    from: 0,
    to: 120000,
    isExecuting: (entry) => entry.command === 'npm install',
  });
  assert.strictEqual(sent, 0, 'a slow command is not a permission prompt');
});

test('notifies once execution corroboration stops matching', () => {
  const state = { conv1: gate({ ts: 0, command: 'npm install' }) };
  let running = true;
  const sent = runWatcher(state, {
    from: 0,
    to: 120000,
    isExecuting: () => running && (running = false),
  });
  assert.strictEqual(sent, 1);
});

test('drops abandoned gates instead of notifying forever', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const decision = decide(state, MAX_AGE + 1, undefined);
  assert.deepStrictEqual(decision.notify, []);
  assert.deepStrictEqual(decision.expired, ['conv1']);

  applyDecision(state, decision);
  assert.deepStrictEqual(state, {});
});

test('a failed send is retried rather than swallowed', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const first = decide(state, TIMEOUT, undefined);
  assert.deepStrictEqual(first.notify, ['conv1']);

  // Network error: nothing actually went out, so nothing is marked notified.
  applyDecision(state, { notify: [], expired: first.expired });
  assert.strictEqual(state.conv1.notified, false);

  const second = decide(state, TIMEOUT + 5000, undefined);
  assert.deepStrictEqual(second.notify, ['conv1']);
});

test('does not mute a new request that opened mid-send', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const decision = decide(state, TIMEOUT, undefined);
  assert.deepStrictEqual(decision.notify, ['conv1']);

  // While the push was in flight the user approved and the agent hit a second
  // gate, so the hooks replaced the entry with a fresh one.
  const fresh = { conv1: gate({ ts: TIMEOUT + 500 }) };
  applyDecision(fresh, decision, decision.observedTs);
  assert.strictEqual(
    fresh.conv1.notified,
    false,
    'the replacement gate must still be able to notify'
  );

  const next = decide(fresh, TIMEOUT + 500 + TIMEOUT, undefined);
  assert.deepStrictEqual(next.notify, ['conv1']);
});

test('does not resurrect a gate resolved mid-send', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const decision = decide(state, TIMEOUT, undefined);

  const fresh = {};
  const { changed } = applyDecision(fresh, decision, decision.observedTs);
  assert.strictEqual(changed, false);
  assert.deepStrictEqual(fresh, {});
});

test('survives a half-written or corrupt state file', () => {
  assert.deepStrictEqual(parsePendingState('{"conv1": {"ts": 1'), {});
  assert.deepStrictEqual(parsePendingState(''), {});
  assert.deepStrictEqual(parsePendingState('[]'), {});
  assert.deepStrictEqual(parsePendingState('null'), {});
});

test('discards entries with a malformed timestamp', () => {
  const state = { conv1: { ts: 'nope' } };
  const decision = decide(state, 60000, undefined);
  assert.deepStrictEqual(decision.notify, []);
  assert.deepStrictEqual(decision.expired, ['conv1']);
});
