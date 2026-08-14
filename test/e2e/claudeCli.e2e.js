#!/usr/bin/env node
/**
 * End-to-end check against the real Claude Code CLI: `npm run test:e2e`.
 *
 * The unit suite feeds the hook payloads we believe Claude Code sends. This one
 * removes the belief — it installs the hooks into a throwaway directory, points
 * them at a local stub instead of ntfy, and lets the actual `claude` binary fire
 * them. If Claude Code ever renames an event or a payload field, this fails and
 * the unit suite does not.
 *
 * Not part of `npm test`: it needs the CLI on PATH, working credentials, and it
 * spends a few tokens per run.
 *
 * `--setting-sources project` keeps the developer's own ~/.claude/settings.json
 * out of the run, so the only hooks that fire are the ones installed here and no
 * push can escape to a real topic.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TEMPLATE_ROOT = path.join(__dirname, '..', '..', 'hooks-template');
const CLAUDE_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const PROMPT = 'Reply with exactly the word pong. Do not use any tools.';

async function startNtfyStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({ raw: body });
      }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function install(root, serverUrl, { events = CLAUDE_EVENTS } = {}) {
  const hooks = path.join(root, 'hooks');
  fs.cpSync(TEMPLATE_ROOT, hooks, { recursive: true });
  fs.mkdirSync(path.join(hooks, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(hooks, 'cursorping.config.json'),
    JSON.stringify({ ntfyTopic: 'e2e-topic', serverUrl }, null, 2),
    'utf8'
  );

  const script = path.join(hooks, 'pingy-claude.js').replace(/\\/g, '/');
  const settings = {
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [{ hooks: [{ type: 'command', command: `node "${script}" ${event}`, timeout: 10 }] }],
      ])
    ),
  };
  const settingsPath = path.join(root, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { hooks, settingsPath };
}

/**
 * Resolve the binary ourselves. `shell: true` would be enough to find
 * `claude.exe` on PATH, but then cmd.exe re-splits the arguments and the prompt
 * arrives as its first word only.
 */
function resolveClaude() {
  const names =
    process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
      if (dir && fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('claude CLI not found on PATH');
}

function runClaude(cwd, settingsPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveClaude(),
      [
        '-p',
        PROMPT,
        '--settings',
        settingsPath,
        '--setting-sources',
        'project',
        '--permission-mode',
        'dontAsk',
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** One real `claude -p` run against a throwaway install. */
async function runCase(label, events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pingy-e2e-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const ntfy = await startNtfyStub();
  const { hooks, settingsPath } = install(root, ntfy.url, { events });

  try {
    console.log(`\n== ${label} ==`);
    const run = await runClaude(project, settingsPath);
    console.log(`claude exited ${run.code}: ${run.stdout.trim().slice(0, 120)}`);
    if (run.code !== 0) {
      console.error(run.stderr.trim().slice(0, 2000));
      throw new Error('the CLI itself failed — check credentials before reading further');
    }

    // Give the Stop hook's POST a moment to land after the CLI exits.
    for (let i = 0; i < 40 && !ntfy.received.length; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log('pushes:', JSON.stringify(ntfy.received.map((n) => n.title)));
    return {
      project,
      pushes: ntfy.received,
      stateDir: path.join(hooks, 'state'),
      cleanup: async () => {
        await ntfy.close();
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await ntfy.close();
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  // Phase 1 leaves SessionEnd unregistered so the session state survives the run
  // and can be inspected. Phase 2 registers everything and checks the cleanup.
  const live = await runCase(
    'completion push, state left intact',
    CLAUDE_EVENTS.filter((e) => e !== 'SessionEnd')
  );
  try {
    console.log(live.pushes.map((n) => n.message).join('\n---\n'));

    assert.deepStrictEqual(
      live.pushes.map((n) => n.title),
      ['Completed'],
      'a finished headless turn is exactly one completion push'
    );
    const [push] = live.pushes;
    assert.match(push.message, /Agent: Claude Code/);
    assert.match(push.message, new RegExp(`Project: ${path.basename(live.project)}`));
    assert.match(push.message, /Reply with exactly the word pong/, 'prompt context survived');
    assert.strictEqual(push.priority, 3);
    assert.ok(!push.message.includes('Note:'), 'no background work was left running');

    // UserPromptSubmit must record the turn — that is what suppresses the idle
    // notice later and re-arms the waiting push.
    const sessions = readJson(path.join(live.stateDir, 'claude-sessions.json'));
    const [entry] = Object.values(sessions);
    assert.ok(entry, 'the hook saw a real session id');
    assert.strictEqual(typeof entry.turnAt, 'number', 'UserPromptSubmit fired');
    assert.strictEqual(typeof entry.stopAt, 'number', 'Stop fired');
    assert.strictEqual(entry.waitingAt, null, 'nothing blocked, so nothing to claim');
    // `source` is optional in the hook schema and today's CLI omits it, which is
    // why an absent source has to mean "treat it as a real turn and push". If a
    // future build starts sending it, `/loop` ticks go quiet — see claudeState.js.
    assert.ok(
      entry.turnSource === null || entry.turnSource === 'sdk',
      `unexpected turn source ${JSON.stringify(entry.turnSource)}`
    );
    console.log(`turn source reported by the CLI: ${JSON.stringify(entry.turnSource)}`);

    const prompts = readJson(path.join(live.stateDir, 'prompts.json'));
    assert.match(
      Object.values(prompts)[0].firstPrompt,
      /Reply with exactly the word pong/,
      'the real UserPromptSubmit payload field is still called `prompt`'
    );
  } finally {
    await live.cleanup();
  }

  const ended = await runCase('SessionEnd clears its own state', CLAUDE_EVENTS);
  try {
    assert.deepStrictEqual(ended.pushes.map((n) => n.title), ['Completed']);
    assert.deepStrictEqual(
      readJson(path.join(ended.stateDir, 'claude-sessions.json')),
      {},
      'SessionEnd fired and pruned the session'
    );
    assert.deepStrictEqual(
      readJson(path.join(ended.stateDir, 'prompts.json')),
      {},
      'SessionEnd fired and forgot the prompt'
    );
  } finally {
    await ended.cleanup();
  }

  console.log('\nOK — real Claude Code fires UserPromptSubmit, Stop and SessionEnd,');
  console.log('and one finished turn produces exactly one push.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
