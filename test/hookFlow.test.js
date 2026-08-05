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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorping-test-'));
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

function fireHook(dir, event, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'cursorping.js'), event], {
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
    child.stdin.end(JSON.stringify({ conversation_id: 'conv1', ...payload }));
  });
}

function readPending(dir) {
  const file = path.join(dir, 'state', 'pending.json');
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('hook bridge gate lifecycle', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);

  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a shell gate records a pending entry', async () => {
    const result = await fireHook(dir, 'beforeShellExecution', {
      command: 'npm install',
    });
    assert.strictEqual(result.code, 0);

    const pending = readPending(dir);
    assert.strictEqual(pending.conv1.notified, false);
    assert.strictEqual(pending.conv1.command, 'npm install');
    assert.strictEqual(pending.conv1.event, 'beforeShellExecution');

    // Clear so the detached permission timer does not fire mid-suite.
    await fireHook(dir, 'afterShellExecution', { command: 'npm install' });
  });

  await t.test('the gate hook never overrides Cursor approval flow', async () => {
    const result = await fireHook(dir, 'beforeShellExecution', {
      command: 'rm -rf /',
    });
    assert.strictEqual(
      result.stdout.trim(),
      '',
      'emitting a permission decision would auto-approve and hide the prompt'
    );
    await fireHook(dir, 'afterShellExecution', { command: 'rm -rf /' });
  });

  await t.test('approval clears the gate', async () => {
    await fireHook(dir, 'beforeShellExecution', { command: 'npm test' });
    await fireHook(dir, 'afterShellExecution', {
      command: 'npm test',
      output: 'ok',
      duration: 1200,
    });
    assert.deepStrictEqual(readPending(dir), {});
  });

  await t.test('rejection clears the gate', async () => {
    await fireHook(dir, 'preToolUse', {
      tool_name: 'Shell',
      tool_input: { command: 'curl example.com' },
    });
    assert.ok(readPending(dir).conv1);

    await fireHook(dir, 'postToolUseFailure', {
      tool_name: 'Shell',
      failure_type: 'permission_denied',
    });
    assert.deepStrictEqual(readPending(dir), {});
  });

  await t.test('a non-shell tool gate is tracked too', async () => {
    await fireHook(dir, 'preToolUse', {
      tool_name: 'WebSearch',
      tool_input: { query: 'cursor hooks' },
    });
    assert.strictEqual(readPending(dir).conv1.toolName, 'WebSearch');

    await fireHook(dir, 'postToolUse', { tool_name: 'WebSearch' });
    assert.deepStrictEqual(readPending(dir), {});
  });

  await t.test('an MCP gate is tracked too', async () => {
    await fireHook(dir, 'beforeMCPExecution', { tool_name: 'linear_search' });
    assert.strictEqual(readPending(dir).conv1.toolName, 'linear_search');

    await fireHook(dir, 'afterMCPExecution', { tool_name: 'linear_search' });
    assert.deepStrictEqual(readPending(dir), {});
  });

  await t.test('thinking and tool activity stay silent', async () => {
    await fireHook(dir, 'afterAgentThought', { text: 'considering options' });
    await fireHook(dir, 'afterFileEdit', { file_path: '/tmp/x.ts', edits: [] });
    await fireHook(dir, 'afterAgentResponse', { text: 'done reasoning' });
    assert.strictEqual(ntfy.received.length, 0);
  });
});

test('completion notifications still work', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);

  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await fireHook(dir, 'beforeSubmitPrompt', {
    prompt: 'add a login page',
  });
  await fireHook(dir, 'beforeShellExecution', { command: 'npm run build' });
  await fireHook(dir, 'stop', {
    status: 'completed',
    workspace_roots: ['/home/me/checkout-api'],
  });

  assert.strictEqual(ntfy.received.length, 1, 'exactly one completion ping');
  assert.strictEqual(ntfy.received[0].title, 'Completed');
  assert.match(ntfy.received[0].body, /Your agent cooked/);
  assert.match(ntfy.received[0].body, /add a login page/);
  assert.deepStrictEqual(readPending(dir), {}, 'stop also clears any open gate');
});

test('error and aborted completions keep their own copy', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);

  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await fireHook(dir, 'stop', {
    status: 'error',
    workspace_roots: ['/home/me/checkout-api'],
  });
  await fireHook(dir, 'stop', {
    status: 'aborted',
    workspace_roots: ['/home/me/checkout-api'],
  });

  assert.strictEqual(ntfy.received.length, 2);
  assert.strictEqual(ntfy.received[0].title, '🚨 Error');
  assert.match(ntfy.received[0].body, /hit a snag/);
  assert.strictEqual(ntfy.received[1].title, 'Stopped');
});

test('permission check notifies only while the gate stays open', async (t) => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);

  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await fireHook(dir, 'beforeShellExecution', {
    conversation_id: 'conv1',
    command: 'hostname',
  });
  assert.ok(readPending(dir).conv1);

  // Gate cleared before the delay ⇒ no notification.
  await fireHook(dir, 'afterShellExecution', {
    conversation_id: 'conv1',
    command: 'hostname',
  });
  await new Promise((r) => setTimeout(r, 2500));
  assert.strictEqual(ntfy.received.length, 0);

  await fireHook(dir, 'beforeShellExecution', {
    conversation_id: 'conv1',
    command: 'hostname',
  });
  await new Promise((r) => setTimeout(r, 2500));
  assert.strictEqual(ntfy.received.length, 1);
  assert.strictEqual(ntfy.received[0].title, '👀 Waiting');
  assert.match(ntfy.received[0].body, /Hey, your agent needs you/);
  assert.ok(!ntfy.received[0].body.includes('👀'));
  assert.strictEqual(readPending(dir).conv1.notified, true);

  // Still open ⇒ no second push.
  await new Promise((r) => setTimeout(r, 2500));
  assert.strictEqual(ntfy.received.length, 1);
});

test('BOM-prefixed stdin still records a pending gate', async () => {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'cursorping.js'), 'beforeShellExecution'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CURSORPING_STATE_DIR: path.join(dir, 'state'),
      },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      assert.strictEqual(code, 0);
      resolve();
    });
    // Cursor on Windows prefixes hook stdin with a UTF-8 BOM.
    child.stdin.end(
      `\uFEFF${JSON.stringify({
        conversation_id: 'bom-conv',
        command: 'ipconfig',
      })}`
    );
  });

  const pending = readPending(dir);
  assert.ok(pending['bom-conv'], 'BOM must not prevent markPending');
  assert.strictEqual(pending['bom-conv'].command, 'ipconfig');

  await fireHook(dir, 'afterShellExecution', {
    conversation_id: 'bom-conv',
    command: 'ipconfig',
  });
  await ntfy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('permission copy is exactly what the spec asks for', () => {
  const { permissionMessage, stopMessage } = require(path.join(
    TEMPLATE_ROOT,
    'lib',
    'messages.js'
  ));
  const hookWait = permissionMessage('demo');
  const extWait = require('../out/messages').permissionMessage('demo');
  const hookDone = stopMessage('completed', 'demo');
  const hookErr = stopMessage('error', 'demo');

  assert.strictEqual(hookWait.title, '👀 Waiting');
  assert.match(hookWait.message, /Hey, your agent needs you/);
  assert.ok(!hookWait.message.includes('👀'));
  assert.match(hookWait.message, /Project: demo/);
  assert.deepStrictEqual(extWait, hookWait);

  assert.strictEqual(hookDone.title, 'Completed');
  assert.match(hookDone.message, /Your agent cooked/);
  assert.strictEqual(hookErr.title, '🚨 Error');
  assert.match(hookErr.message, /hit a snag/);
});
