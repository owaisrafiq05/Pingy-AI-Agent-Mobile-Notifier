const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const TEMPLATE_ROOT = path.join(__dirname, '..', 'hooks-template');

/** Stands in for ntfy so the suite never touches the network. */
async function startNtfyStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let title = req.headers.title;
      let message = body;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          title = parsed.title ?? title;
          message = parsed.message ?? body;
        }
      } catch {
        /* plain-text body publish */
      }
      received.push({ title, body: message });
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

function installHooks(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingy-claude-test-'));
  fs.cpSync(TEMPLATE_ROOT, dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cursorping.config.json'),
    JSON.stringify({
      ntfyTopic: 'test-topic',
      serverUrl,
      pendingTimeoutMs: 2000,
    }),
    'utf8'
  );
  return dir;
}

function fireHook(dir, event, payload, { raw } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'pingy-claude.js'), event], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CURSORPING_STATE_DIR: path.join(dir, 'state'),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(
      raw ??
        JSON.stringify({
          session_id: 'sess1',
          cwd: '/home/me/checkout-api',
          hook_event_name: event,
          ...payload,
        })
    );
  });
}

test('Stop pushes a completion labelled Claude Code', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = await fireHook(dir, 'Stop', {
    last_assistant_message: 'All done.',
  });

  assert.strictEqual(result.code, 0);
  assert.strictEqual(ntfy.received.length, 1, 'exactly one completion ping');
  assert.strictEqual(ntfy.received[0].title, 'Completed');
  assert.match(ntfy.received[0].body, /Your agent cooked/);
  assert.match(ntfy.received[0].body, /Project: checkout-api/);
  assert.match(ntfy.received[0].body, /Agent: Claude Code/);
});

test('StopFailure pushes the error copy', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await fireHook(dir, 'StopFailure', {
    error_type: 'rate_limit',
    error_message: 'slow down',
  });

  assert.strictEqual(ntfy.received.length, 1);
  assert.strictEqual(ntfy.received[0].title, '🚨 Error');
  assert.match(ntfy.received[0].body, /hit a snag/);
  assert.match(ntfy.received[0].body, /Agent: Claude Code/);
});

test('a blocking Notification pushes the waiting alert', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = await fireHook(dir, 'Notification', {
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  });

  assert.strictEqual(result.code, 0);
  assert.strictEqual(
    result.stdout.trim(),
    '',
    'stdout must stay empty so the approval flow is never overridden'
  );
  assert.strictEqual(ntfy.received.length, 1);
  assert.strictEqual(ntfy.received[0].title, '👀 Waiting');
  assert.match(ntfy.received[0].body, /Hey, your agent needs you/);
  assert.match(ntfy.received[0].body, /Agent: Claude Code/);
});

test('idle and needs-input notifications also count as waiting', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Distinct sessions so the back-to-back dedupe guard does not swallow one.
  await fireHook(dir, 'Notification', {
    session_id: 'idle-sess',
    notification_type: 'idle_prompt',
  });
  await fireHook(dir, 'Notification', {
    session_id: 'input-sess',
    notification_type: 'agent_needs_input',
  });

  assert.strictEqual(ntfy.received.length, 2);
  assert.ok(ntfy.received.every((n) => n.title === '👀 Waiting'));
});

test('non-blocking notifications stay silent', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const notification_type of [
    'auth_success',
    'elicitation_dialog',
    'elicitation_complete',
    // Stop already covers completion — handling this too would double-push.
    'agent_completed',
  ]) {
    const result = await fireHook(dir, 'Notification', {
      session_id: `sess-${notification_type}`,
      notification_type,
    });
    assert.strictEqual(result.code, 0);
  }

  assert.strictEqual(ntfy.received.length, 0);
});

test('a repeated waiting notification does not double-push', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  await fireHook(dir, 'Notification', { notification_type: 'agent_needs_input' });

  assert.strictEqual(
    ntfy.received.length,
    1,
    'two notices for the same block are one interruption'
  );
});

test('UserPromptSubmit is silent but feeds the completion body', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const submit = await fireHook(dir, 'UserPromptSubmit', {
    prompt: 'add a login page',
  });

  assert.strictEqual(submit.code, 0);
  assert.strictEqual(
    submit.stdout.trim(),
    '',
    'UserPromptSubmit stdout is injected into the model context — it must be empty'
  );
  assert.strictEqual(ntfy.received.length, 0, 'submitting a prompt is not a ping');

  await fireHook(dir, 'Stop', {});
  assert.strictEqual(ntfy.received.length, 1);
  assert.match(ntfy.received[0].body, /add a login page/);
});

test('harness-injected turns are not mistaken for the user prompt', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Claude Code fires UserPromptSubmit for these too. firstPrompt is sticky, so
  // storing one would poison every push for the rest of the session.
  for (const injected of [
    '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>',
    '<system-reminder>Today is 2026-08-10.</system-reminder>',
    '<local-command-stdout>Enabled plan mode</local-command-stdout>',
    '<command-name>/plan</command-name>',
  ]) {
    await fireHook(dir, 'UserPromptSubmit', { prompt: injected });
  }

  assert.ok(
    !fs.existsSync(path.join(dir, 'state', 'prompts.json')),
    'nothing worth remembering means nothing written'
  );

  await fireHook(dir, 'UserPromptSubmit', { prompt: 'add a login page' });
  await fireHook(dir, 'Stop', {});

  assert.match(ntfy.received[0].body, /Prompt: "add a login page"/);
  assert.ok(
    !ntfy.received[0].body.includes('task-notification'),
    'a real prompt must not be shadowed by injected text'
  );
});

test('an oversized prompt is capped before it is stored', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await fireHook(dir, 'UserPromptSubmit', { prompt: 'x'.repeat(50_000) });

  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, 'state', 'prompts.json'), 'utf8')
  );
  assert.ok(
    Object.values(stored)[0].firstPrompt.length <= 400,
    'prompts.json must not accumulate multi-KB blobs'
  );
});

test('SessionEnd forgets the stored prompt', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await fireHook(dir, 'UserPromptSubmit', { prompt: 'ship the thing' });
  await fireHook(dir, 'SessionEnd', { end_reason: 'clear' });

  const prompts = JSON.parse(
    fs.readFileSync(path.join(dir, 'state', 'prompts.json'), 'utf8')
  );
  assert.deepStrictEqual(prompts, {}, 'prompts.json must not grow forever');
});

test('unknown events and BOM-prefixed stdin never break the agent', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const unknown = await fireHook(dir, 'PreToolUse', { tool_name: 'Bash' });
  assert.strictEqual(unknown.code, 0);
  assert.strictEqual(unknown.stdout.trim(), '');
  assert.strictEqual(ntfy.received.length, 0, 'unhandled events must be no-ops');

  // Hook stdin on Windows can carry a UTF-8 BOM, which JSON.parse rejects.
  const bom = await fireHook(dir, 'Stop', null, {
    raw: `\uFEFF${JSON.stringify({
      session_id: 'bom-sess',
      cwd: '/home/me/checkout-api',
    })}`,
  });
  assert.strictEqual(bom.code, 0);
  assert.strictEqual(ntfy.received.length, 1);
  assert.match(
    ntfy.received[0].body,
    /Project: checkout-api/,
    'a BOM must not swallow the payload'
  );
});

test('the event name falls back to the payload when argv is absent', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'pingy-claude.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CURSORPING_STATE_DIR: path.join(dir, 'state') },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      assert.strictEqual(code, 0);
      resolve();
    });
    child.stdin.end(
      JSON.stringify({
        session_id: 'argvless',
        cwd: '/home/me/checkout-api',
        hook_event_name: 'Stop',
      })
    );
  });

  assert.strictEqual(ntfy.received.length, 1);
  assert.strictEqual(ntfy.received[0].title, 'Completed');
});

test('Claude copy stays in sync with the extension copy', () => {
  const hookMessages = require(path.join(TEMPLATE_ROOT, 'lib', 'messages.js'));
  const extMessages = require('../out/messages');

  const labelled = hookMessages.permissionMessage('demo', null, 'Claude Code');
  assert.deepStrictEqual(
    extMessages.permissionMessage('demo', null, 'Claude Code'),
    labelled
  );
  assert.match(labelled.message, /Project: demo\nAgent: Claude Code/);

  // Omitting the label must reproduce the pre-0.4.0 body exactly.
  const unlabelled = hookMessages.permissionMessage('demo');
  assert.ok(!unlabelled.message.includes('Agent:'));
});
