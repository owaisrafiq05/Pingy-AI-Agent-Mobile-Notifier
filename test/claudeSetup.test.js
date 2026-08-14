const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * runClaudeSetup writes into the user's real ~/.claude/settings.json, which
 * holds unrelated settings (theme, update channel, permissions, other tools'
 * hooks). These tests pin the merge against a fake home directory.
 *
 * The wizard imports `vscode`, which does not resolve outside the extension
 * host, so we register a stub before loading the compiled module.
 */
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') {
    return 'vscode';
  }
  return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeStub,
};

const realHomedir = os.homedir;
const { runClaudeSetup } = require('../out/setupWizard');

function withFakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pingy-home-'));
  os.homedir = () => home;
  t.after(() => {
    os.homedir = realHomedir;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

/** Minimal stand-in for vscode.ExtensionContext. */
const context = { extensionPath: path.join(__dirname, '..') };

function settingsPath(home) {
  return path.join(home, '.claude', 'settings.json');
}

function readSettings(home) {
  return JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
}

function pingyHandlers(settings, event) {
  return (settings.hooks[event] ?? [])
    .flatMap((group) => group.hooks ?? [])
    .filter((h) => (h.command ?? '').includes('pingy-claude.js'));
}

test('installs the hook scripts and a config carrying the shared topic', async (t) => {
  const home = withFakeHome(t);
  await runClaudeSetup(context, 'pingy-abc12345');

  const hooksDir = path.join(home, '.claude', 'hooks', 'pingy');
  assert.ok(fs.existsSync(path.join(hooksDir, 'pingy-claude.js')));
  assert.ok(fs.existsSync(path.join(hooksDir, 'lib', 'notifier.js')));
  assert.ok(fs.existsSync(path.join(hooksDir, 'lib', 'config.js')));

  const config = JSON.parse(
    fs.readFileSync(path.join(hooksDir, 'cursorping.config.json'), 'utf8')
  );
  assert.strictEqual(
    config.ntfyTopic,
    'pingy-abc12345',
    'both agents must publish to one topic so a single pairing covers them'
  );
});

test('registers every event with an absolute, quoted command', async (t) => {
  const home = withFakeHome(t);
  await runClaudeSetup(context, 'pingy-abc12345');

  const settings = readSettings(home);
  for (const event of [
    'UserPromptSubmit',
    'Notification',
    'Stop',
    'StopFailure',
    'SessionEnd',
  ]) {
    const handlers = pingyHandlers(settings, event);
    assert.strictEqual(handlers.length, 1, `${event} should have one handler`);
    assert.strictEqual(handlers[0].type, 'command');
    // Absolute (POSIX root or a Windows drive), forward slashes, quoted.
    assert.match(
      handlers[0].command,
      /^node "(?:\/|[A-Za-z]:\/).*\/pingy-claude\.js" \w+$/,
      'Claude runs hooks from the project cwd, so the path must be absolute and quoted'
    );
    assert.ok(
      !handlers[0].command.includes('\\'),
      'backslashes would need JSON escaping and break on POSIX'
    );
    assert.match(handlers[0].command, new RegExp(`${event}$`));
  }

  const notification = settings.hooks.Notification.find((g) =>
    (g.hooks ?? []).some((h) => (h.command ?? '').includes('pingy-claude.js'))
  );
  assert.deepStrictEqual(notification.matcher.split('|').sort(), [
    'agent_needs_input',
    'elicitation_dialog',
    'elicitation_url_dialog',
    'idle_prompt',
    'permission_prompt',
    'worker_permission_prompt',
  ]);
  // On Notification the matcher is tested against `notification_type`. Claude
  // Code only takes the plain alternation fast path for this character set —
  // anything else is compiled as a regex, where `_` boundaries stop being exact.
  assert.match(notification.matcher, /^[A-Za-z0-9_|]+$/);
});

test('the settings matcher does not filter out a type the hook handles', async (t) => {
  // The matcher is the first gate and the hook is the second. If they disagree,
  // the stricter one wins silently — a blocked agent with no push.
  const home = withFakeHome(t);
  await runClaudeSetup(context, 'pingy-abc12345');

  const notification = readSettings(home).hooks.Notification.find((g) =>
    (g.hooks ?? []).some((h) => (h.command ?? '').includes('pingy-claude.js'))
  );

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'hooks-template', 'pingy-claude.js'),
    'utf8'
  );
  const block = source.slice(
    source.indexOf('const WAITING_TYPES'),
    source.indexOf(']);', source.indexOf('const WAITING_TYPES'))
  );
  const handled = [...block.matchAll(/\['([a-z_]+)',/g)].map((m) => m[1]);

  assert.ok(handled.length >= 6, 'sanity: found the type list in the hook');
  assert.deepStrictEqual(notification.matcher.split('|').sort(), handled.sort());
});

test('a home directory containing spaces stays quoted', async (t) => {
  const home = withFakeHome(t);
  const spaced = path.join(home, 'MY PC');
  fs.mkdirSync(spaced, { recursive: true });
  os.homedir = () => spaced;

  await runClaudeSetup(context, 'pingy-abc12345');

  const command = pingyHandlers(readSettings(spaced), 'Stop')[0].command;
  assert.match(command, /"[^"]*MY PC[^"]*pingy-claude\.js"/);
});

test('preserves unrelated settings and other tools hooks', async (t) => {
  const home = withFakeHome(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    settingsPath(home),
    JSON.stringify({
      theme: 'dark',
      autoUpdatesChannel: 'latest',
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo someone-elses-hook' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }],
      },
    }),
    'utf8'
  );

  await runClaudeSetup(context, 'pingy-abc12345');
  const settings = readSettings(home);

  assert.strictEqual(settings.theme, 'dark');
  assert.strictEqual(settings.autoUpdatesChannel, 'latest');
  assert.deepStrictEqual(settings.permissions, { allow: ['Bash(npm test)'] });

  // An event we never touch must be exactly as it was.
  assert.deepStrictEqual(settings.hooks.PreToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] },
  ]);

  const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
  assert.ok(stopCommands.includes('echo someone-elses-hook'), 'foreign hook survives');
  assert.strictEqual(pingyHandlers(settings, 'Stop').length, 1);
});

test('re-running setup does not stack duplicate handlers', async (t) => {
  const home = withFakeHome(t);

  await runClaudeSetup(context, 'pingy-abc12345');
  await runClaudeSetup(context, 'pingy-abc12345');
  await runClaudeSetup(context, 'pingy-abc12345');

  const settings = readSettings(home);
  for (const event of ['UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']) {
    assert.strictEqual(pingyHandlers(settings, event).length, 1, `${event} duplicated`);
  }
  // Groups emptied by the strip must be dropped, not left as {hooks: []}.
  assert.ok(settings.hooks.Stop.every((g) => (g.hooks ?? []).length > 0));
});

test('a corrupt settings file is backed up rather than lost', async (t) => {
  const home = withFakeHome(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(settingsPath(home), '{ this is not json', 'utf8');

  await runClaudeSetup(context, 'pingy-abc12345');

  const backups = fs
    .readdirSync(path.join(home, '.claude'))
    .filter((f) => f.startsWith('settings.json.bak-'));
  assert.strictEqual(backups.length, 1, 'the unreadable original must be kept');
  assert.strictEqual(pingyHandlers(readSettings(home), 'Stop').length, 1);
});
