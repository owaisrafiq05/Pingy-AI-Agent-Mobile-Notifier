const test = require('node:test');
const assert = require('node:assert');

const {
  decidePending,
  applyDecision,
  parsePendingState,
  hasNotifiedPending,
  isPromptableGate,
} = require('../out/pendingState');

const WAITING_AFTER = 8000;
const MAX_AGE = 30 * 60 * 1000;

/** A shell gate: the kind Cursor really can stop and ask about. */
function gate(overrides = {}) {
  return {
    ts: 0,
    notified: false,
    event: 'beforeShellExecution',
    toolName: 'Shell',
    command: 'npm test',
    promptable: true,
    ...overrides,
  };
}

/** The generic pre-tool gate Cursor fires for reads, searches and edits. */
function toolGate(overrides = {}) {
  return gate({
    event: 'preToolUse',
    toolName: 'ReadFile',
    command: null,
    promptable: false,
    ...overrides,
  });
}

function mcpGate(overrides = {}) {
  return gate({
    event: 'beforeMCPExecution',
    toolName: 'MCP',
    command: null,
    promptable: true,
    ...overrides,
  });
}

/**
 * Defaults describe the one case that is unambiguously a prompt: a shell gate in
 * a window where terminal activity reports, with nothing running. Tests that care
 * about weaker evidence override these.
 */
function decide(state, now, opts = {}) {
  return decidePending(state, {
    now,
    waitingAfterMs: WAITING_AFTER,
    maxAgeMs: MAX_AGE,
    shellActivityAvailable: true,
    isExecuting: () => false,
    userPresent: false,
    ...opts,
  });
}

/**
 * Simulates the extension watcher polling the file the hooks write, so the
 * assertions below count real would-be notifications.
 */
function runWatcher(state, { from, to, stepMs = 5000, ...opts } = {}) {
  let sent = 0;
  for (let now = from; now <= to; now += stepMs) {
    const decision = decide(state, now, opts);
    sent += decision.notify.length;
    applyDecision(state, decision);
  }
  return sent;
}

test('uncorroborated shell notifies even while the user is present', () => {
  // Presence used to veto forever if you kept Cursor focused — real Run/Skip
  // prompts then never reached the phone. waitingAfterMs is the filter now.
  const state = { conv1: gate({ ts: 0, command: 'npm run build' }) };
  const sent = runWatcher(state, {
    from: 0,
    to: 120000,
    shellActivityAvailable: false,
    allowUncorroboratedShell: true,
    userPresent: true,
  });
  assert.strictEqual(sent, 1);
});

test('uncorroborated shell can still be opted out', () => {
  const state = { conv1: gate({ ts: 0, command: 'npm run build' }) };
  const sent = runWatcher(state, {
    from: 0,
    to: 10 * 60 * 1000,
    shellActivityAvailable: false,
    allowUncorroboratedShell: false,
    userPresent: false,
  });
  assert.strictEqual(sent, 0);
});

test('a slow read or search is never a permission prompt', () => {
  // preToolUse covers every tool the agent uses; Cursor applies those itself.
  const state = { conv1: toolGate({ ts: 0 }) };
  const sent = runWatcher(state, {
    from: 0,
    to: 10 * 60 * 1000,
    userPresent: false,
    shellActivityAvailable: true,
  });
  assert.strictEqual(sent, 0);
});

test('stays quiet while a gate resolves quickly', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const sent = runWatcher(state, { from: 0, to: WAITING_AFTER - 1, stepMs: 1000 });
  assert.strictEqual(sent, 0);
});

test('notifies when a shell prompt is corroborated by an idle terminal', () => {
  const state = { conv1: gate({ ts: 0 }) };
  assert.deepStrictEqual(decide(state, WAITING_AFTER).notify, ['conv1']);
});

test('MCP gates notify after the wait window even when present', () => {
  const state = { conv1: mcpGate({ ts: 0 }) };
  const sent = runWatcher(state, { from: 0, to: 120000, userPresent: true });
  assert.strictEqual(sent, 1);
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

test('an MCP gate notifies from age alone (no terminal signal needed)', () => {
  const state = { conv1: mcpGate({ ts: 0 }) };
  assert.strictEqual(runWatcher(state, { from: 0, to: 120000 }), 1);
});

test('never notifies twice while the prompt stays open', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const sent = runWatcher(state, { from: 0, to: 10 * 60 * 1000 });
  assert.strictEqual(sent, 1, 'a prompt left open for ten minutes must ping once');
  assert.ok(hasNotifiedPending(state));
});

test('re-arms for the next request after the user approves', () => {
  const state = { conv1: gate({ ts: 0 }) };
  let sent = runWatcher(state, { from: 0, to: 120000 });
  assert.strictEqual(sent, 1);

  // Approval: the tool runs and postToolUse clears the entry.
  delete state.conv1;
  sent += runWatcher(state, { from: 120000, to: 180000 });
  assert.strictEqual(sent, 1, 'clearing the gate must not itself notify');

  // Next permission request in the same conversation.
  state.conv1 = gate({ ts: 200000 });
  sent += runWatcher(state, { from: 200000, to: 320000 });
  assert.strictEqual(sent, 2, 'the following request gets its own notification');
});

test('re-arms after the user rejects', () => {
  const state = { conv1: gate({ ts: 0 }) };
  assert.strictEqual(runWatcher(state, { from: 0, to: 120000 }), 1);

  // Rejection: postToolUseFailure(permission_denied) clears the entry.
  delete state.conv1;
  state.conv1 = gate({ ts: 130000 });
  assert.strictEqual(runWatcher(state, { from: 130000, to: 250000 }), 1);
});

test('tracks each conversation independently', () => {
  const state = { conv1: gate({ ts: 0 }), conv2: gate({ ts: 0 }) };
  const sent = runWatcher(state, { from: 0, to: 120000 });
  assert.strictEqual(sent, 2);
});

test('drops abandoned gates instead of notifying forever', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const decision = decide(state, MAX_AGE + 1);
  assert.deepStrictEqual(decision.notify, []);
  assert.deepStrictEqual(decision.expired, ['conv1']);

  applyDecision(state, decision);
  assert.deepStrictEqual(state, {});
});

test('a failed send is retried rather than swallowed', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const first = decide(state, WAITING_AFTER);
  assert.deepStrictEqual(first.notify, ['conv1']);

  // Network error: nothing actually went out, so nothing is marked notified.
  applyDecision(state, { notify: [], expired: first.expired });
  assert.strictEqual(state.conv1.notified, false);

  const second = decide(state, WAITING_AFTER + 5000);
  assert.deepStrictEqual(second.notify, ['conv1']);
});

test('does not mute a new request that opened mid-send', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const decision = decide(state, WAITING_AFTER);
  assert.deepStrictEqual(decision.notify, ['conv1']);

  // While the push was in flight the user approved and the agent hit a second
  // gate, so the hooks replaced the entry with a fresh one.
  const fresh = { conv1: gate({ ts: WAITING_AFTER + 500 }) };
  applyDecision(fresh, decision, decision.observedTs);
  assert.strictEqual(
    fresh.conv1.notified,
    false,
    'the replacement gate must still be able to notify'
  );

  const next = decide(fresh, WAITING_AFTER + 500 + WAITING_AFTER);
  assert.deepStrictEqual(next.notify, ['conv1']);
});

test('does not resurrect a gate resolved mid-send', () => {
  const state = { conv1: gate({ ts: 0 }) };
  const decision = decide(state, WAITING_AFTER);

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
  const decision = decide(state, 60000);
  assert.deepStrictEqual(decision.notify, []);
  assert.deepStrictEqual(decision.expired, ['conv1']);
});

test('classifies gates written by an older install', () => {
  // Entries from before the flag existed carry only the event name.
  assert.strictEqual(isPromptableGate({ ts: 0, event: 'beforeShellExecution' }), true);
  assert.strictEqual(isPromptableGate({ ts: 0, event: 'beforeMCPExecution' }), true);
  assert.strictEqual(isPromptableGate({ ts: 0, event: 'preToolUse' }), false);
  // Older still: no event either.
  assert.strictEqual(isPromptableGate({ ts: 0, toolName: 'Shell' }), true);
  assert.strictEqual(isPromptableGate({ ts: 0, toolName: 'ReadFile' }), false);
  assert.strictEqual(isPromptableGate({ ts: 0 }), false);
  // The flag wins when present, whatever the event says.
  assert.strictEqual(
    isPromptableGate({ ts: 0, event: 'preToolUse', promptable: true }),
    true
  );
});

test('a legacy pre-tool entry does not notify after an upgrade', () => {
  const state = { conv1: { ts: 0, notified: false, event: 'preToolUse' } };
  assert.strictEqual(runWatcher(state, { from: 0, to: 10 * 60 * 1000 }), 0);
});
