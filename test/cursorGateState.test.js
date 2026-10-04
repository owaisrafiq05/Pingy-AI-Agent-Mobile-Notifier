const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// state.js resolves its directory at require time.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pingy-gate-state-'));
process.env.CURSORPING_STATE_DIR = STATE_DIR;

const {
  markPending,
  clearPending,
  readState,
  STATE_FILE,
} = require('../hooks-template/lib/state');

test.after(() => fs.rmSync(STATE_DIR, { recursive: true, force: true }));

function reset() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* nothing written yet */
  }
}

const SHELL = {
  event: 'beforeShellExecution',
  toolName: 'Shell',
  command: 'npm run build',
  promptable: true,
};
const GENERIC = {
  event: 'preToolUse',
  toolName: 'ReadFile',
  command: null,
  promptable: false,
};

test('a gate records whether Cursor can ask about it', () => {
  reset();
  markPending('conv1', SHELL);
  assert.strictEqual(readState().conv1.promptable, true);

  reset();
  markPending('conv1', GENERIC);
  assert.strictEqual(readState().conv1.promptable, false);
});

test('a generic gate does not overwrite a fresh promptable one', () => {
  reset();
  markPending('conv1', SHELL);
  const first = readState().conv1;

  markPending('conv1', GENERIC);
  const after = readState().conv1;
  assert.strictEqual(after.promptable, true);
  assert.strictEqual(after.ts, first.ts, 'the open prompt keeps its own clock');
  assert.strictEqual(after.command, 'npm run build');
});

test('the hold expires so a later gate is not blocked by a stale one', () => {
  reset();
  markPending('conv1', SHELL);

  // Age the entry past the hold window instead of sleeping through it.
  const state = readState();
  state.conv1.ts -= 5000;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');

  markPending('conv1', GENERIC);
  assert.strictEqual(readState().conv1.promptable, false);
  assert.strictEqual(readState().conv1.toolName, 'ReadFile');
});

test('a promptable gate still replaces another promptable gate', () => {
  reset();
  markPending('conv1', SHELL);
  markPending('conv1', { ...SHELL, command: 'npm test' });
  assert.strictEqual(readState().conv1.command, 'npm test');
});

test('clearing a gate is what re-arms the next alert', () => {
  reset();
  markPending('conv1', SHELL);
  clearPending('conv1');
  assert.deepStrictEqual(readState(), {});
});

test('an entry from an older install is replaced normally', () => {
  reset();
  // No promptable flag at all — must not be treated as a fresh prompt to protect.
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ conv1: { ts: Date.now(), notified: false, event: 'preToolUse' } }),
    'utf8'
  );

  markPending('conv1', GENERIC);
  assert.strictEqual(readState().conv1.toolName, 'ReadFile');
});
