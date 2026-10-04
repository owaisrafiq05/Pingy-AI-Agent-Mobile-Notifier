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

function installHooks(serverUrl, extraConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingy-claude-test-'));
  fs.cpSync(TEMPLATE_ROOT, dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cursorping.config.json'),
    JSON.stringify({
      ntfyTopic: 'test-topic',
      serverUrl,
      pendingTimeoutMs: 2000,
      ...extraConfig,
    }),
    'utf8'
  );
  return dir;
}

/** Spin up a stub + isolated install and tear both down with the test. */
async function harness(t, extraConfig) {
  const ntfy = await startNtfyStub();
  const dir = installHooks(ntfy.url, extraConfig);
  t.after(async () => {
    await ntfy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ntfy, dir };
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
          // Every Claude Code hook payload carries these three.
          session_id: 'sess1',
          transcript_path: '',
          cwd: '/home/me/checkout-api',
          hook_event_name: event,
          ...payload,
        })
    );
  });
}

/** The events of one ordinary turn, in the order Claude Code fires them. */
async function submitPrompt(dir, prompt, extra = {}) {
  return fireHook(dir, 'UserPromptSubmit', { prompt, source: 'user', ...extra });
}

test('Stop pushes a completion labelled Claude Code', async (t) => {
  const { ntfy, dir } = await harness(t);

  const result = await fireHook(dir, 'Stop', {
    stop_hook_active: false,
    last_assistant_message: 'All done.',
  });

  assert.strictEqual(result.code, 0);
  assert.strictEqual(ntfy.received.length, 1, 'exactly one completion ping');
  assert.strictEqual(ntfy.received[0].title, 'Completed');
  assert.match(ntfy.received[0].body, /Your agent cooked/);
  assert.match(ntfy.received[0].body, /Project: checkout-api/);
  assert.match(ntfy.received[0].body, /Agent: Claude Code/);
});

test('Cursor-hosted Claude Stop hooks stay silent', async (t) => {
  const { ntfy, dir } = await harness(t);

  // Cursor third-party imports run ~/.claude Stop on Cursor agent turns.
  // Those payloads carry Cursor fields; pushing would falsely say Claude Code.
  const result = await fireHook(dir, 'Stop', {
    cursor_version: '2.0.0',
    workspace_roots: ['/home/me/checkout-api'],
    conversation_id: 'cursor-turn',
    status: 'completed',
  });

  assert.strictEqual(result.code, 0);
  assert.strictEqual(
    ntfy.received.length,
    0,
    'Cursor already notifies via cursorping.js — Claude entrypoint must not'
  );
});

test('StopFailure pushes the error copy and names the failure', async (t) => {
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'StopFailure', {
    error: 'rate_limit',
    error_details: 'retry after 60s',
    last_assistant_message: 'Working on it',
  });

  assert.strictEqual(ntfy.received.length, 1);
  assert.strictEqual(ntfy.received[0].title, '🚨 Error');
  assert.match(ntfy.received[0].body, /hit a snag/);
  assert.match(ntfy.received[0].body, /Agent: Claude Code/);
  assert.match(
    ntfy.received[0].body,
    /Error: rate_limit — retry after 60s/,
    'the phone should say what broke'
  );
});

test('an unlabelled StopFailure still says something useful', async (t) => {
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'StopFailure', {});

  assert.strictEqual(ntfy.received.length, 1);
  assert.match(ntfy.received[0].body, /Error: unknown/);
});

test('a blocking Notification pushes the waiting alert with the reason', async (t) => {
  const { ntfy, dir } = await harness(t);

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
  assert.match(
    ntfy.received[0].body,
    /Needs: Claude needs your permission to use Bash/,
    'a push you cannot act on is a push you learn to ignore'
  );
});

test('every dialog that blocks the agent counts as waiting', async (t) => {
  const { ntfy, dir } = await harness(t);

  // Distinct sessions so the per-turn collapse does not swallow one.
  for (const notification_type of [
    'permission_prompt',
    'worker_permission_prompt',
    'agent_needs_input',
    'elicitation_dialog',
    'elicitation_url_dialog',
  ]) {
    await fireHook(dir, 'Notification', {
      session_id: `sess-${notification_type}`,
      notification_type,
    });
  }

  assert.strictEqual(ntfy.received.length, 5);
  assert.ok(ntfy.received.every((n) => n.title === '👀 Waiting'));
  // With no message from Claude Code we supply our own wording per type.
  assert.match(ntfy.received[1].body, /Needs: A teammate session needs your approval/);
  assert.match(ntfy.received[4].body, /Needs: An MCP server needs you to open a URL/);
});

test('notifications that are not blocks stay silent', async (t) => {
  const { ntfy, dir } = await harness(t);

  for (const notification_type of [
    'auth_success',
    'push_notification',
    'computer_use_enter',
    'computer_use_exit',
    // Stop already covers completion — handling this too would double-push.
    'agent_completed',
    'a_type_that_does_not_exist_yet',
  ]) {
    const result = await fireHook(dir, 'Notification', {
      session_id: `sess-${notification_type}`,
      notification_type,
    });
    assert.strictEqual(result.code, 0);
  }

  // A build old enough to omit notification_type bypasses the settings matcher,
  // so untyped notices reach the hook and must not be guessed at.
  await fireHook(dir, 'Notification', {
    session_id: 'sess-untyped',
    message: 'Claude needs your permission to use Bash',
  });

  assert.strictEqual(ntfy.received.length, 0);
});

test('a burst of approval prompts is one interruption, not a dozen pushes', async (t) => {
  // The regression this whole state machine exists for. In `default` permission
  // mode a single turn opens an approval dialog per tool call; Claude Code raises
  // a notification for each one.
  const { ntfy, dir } = await harness(t);

  await submitPrompt(dir, 'refactor the payment module');
  for (const tool of ['Bash', 'Write', 'Bash', 'Edit', 'WebFetch']) {
    await fireHook(dir, 'Notification', {
      notification_type: 'permission_prompt',
      message: `Claude needs your permission to use ${tool}`,
    });
  }

  assert.strictEqual(ntfy.received.length, 1, 'one push per turn, not per dialog');
  assert.match(ntfy.received[0].body, /Needs: Claude needs your permission to use Bash/);
});

test('the next prompt re-arms the waiting push', async (t) => {
  const { ntfy, dir } = await harness(t);

  await submitPrompt(dir, 'first task');
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  assert.strictEqual(ntfy.received.length, 1);

  await submitPrompt(dir, 'second task');
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  assert.strictEqual(ntfy.received.length, 2, 'a new turn is a new interruption');
});

test('a finished turn re-arms the waiting push too', async (t) => {
  // The user answered the prompt and the agent ran to completion, so the next
  // block is genuinely news even without a new typed prompt.
  const { ntfy, dir } = await harness(t);

  await submitPrompt(dir, 'ship it');
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  await fireHook(dir, 'Stop', { last_assistant_message: 'shipped' });
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });

  assert.deepStrictEqual(
    ntfy.received.map((n) => n.title),
    ['👀 Waiting', 'Completed', '👀 Waiting']
  );
});

test('a long block pings again after the configured window', async (t) => {
  const windowMs = 60_000;
  const { ntfy, dir } = await harness(t, { waitingRepingMs: windowMs });
  const stateFile = path.join(dir, 'state', 'claude-sessions.json');

  await submitPrompt(dir, 'long job');
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  assert.strictEqual(ntfy.received.length, 1);

  // Age the claim rather than sleeping: each fireHook spawns a real node process
  // and the suite runs in parallel, so a wall-clock window would be flaky.
  const sessions = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  sessions.sess1.waitingAt -= windowMs + 1_000;
  fs.writeFileSync(stateFile, JSON.stringify(sessions), 'utf8');

  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  assert.strictEqual(ntfy.received.length, 2, 'still blocked much later is news again');
});

test('the 60s idle notice does not contradict the completion push', async (t) => {
  // Claude Code fires idle_prompt a minute after a turn ends. "Your agent needs
  // you" right after "task's done" is the bug users notice first.
  const { ntfy, dir } = await harness(t);

  await submitPrompt(dir, 'add a login page');
  await fireHook(dir, 'Stop', { last_assistant_message: 'Added it.' });
  await fireHook(dir, 'Notification', {
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
  });

  assert.deepStrictEqual(ntfy.received.map((n) => n.title), ['Completed']);
});

test('an idle notice with the turn still running is a real block', async (t) => {
  const { ntfy, dir } = await harness(t);

  await submitPrompt(dir, 'do the thing');
  await fireHook(dir, 'Notification', {
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
  });

  assert.deepStrictEqual(ntfy.received.map((n) => n.title), ['👀 Waiting']);
});

test('one turn stopping twice is one completion push', async (t) => {
  const { ntfy, dir } = await harness(t);

  await submitPrompt(dir, 'run the tests');
  // A second Stop hook that forces the agent onward makes Claude Code re-fire
  // Stop for the same turn, this time with stop_hook_active set.
  await fireHook(dir, 'Stop', { last_assistant_message: 'Tests pass.' });
  await fireHook(dir, 'Stop', {
    stop_hook_active: true,
    last_assistant_message: 'Tests pass.',
  });

  assert.strictEqual(ntfy.received.length, 1);
});

test('two real turns both push', async (t) => {
  const { ntfy, dir } = await harness(t);

  await submitPrompt(dir, 'first');
  await fireHook(dir, 'Stop', { last_assistant_message: 'first answer' });
  await submitPrompt(dir, 'second');
  await fireHook(dir, 'Stop', { last_assistant_message: 'second answer' });

  assert.strictEqual(ntfy.received.length, 2);
});

test('a completion that leaves background work says so', async (t) => {
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'Stop', {
    last_assistant_message: 'Kicked off the build.',
    background_tasks: [
      { id: 'b1', status: 'running' },
      { id: 'b2', status: 'pending' },
      { id: 'b3', status: 'completed' },
    ],
  });

  assert.strictEqual(ntfy.received.length, 1);
  assert.match(
    ntfy.received[0].body,
    /Note: 2 background tasks still running/,
    '"task\'s done" alone would be a half-truth'
  );
});

test('an empty background_tasks array adds no noise', async (t) => {
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'Stop', {
    last_assistant_message: 'Done.',
    background_tasks: [],
  });

  assert.strictEqual(ntfy.received.length, 1);
  assert.ok(!ntfy.received[0].body.includes('Note:'));
});

test('a /loop tick does not push "task\'s done" every wake-up', async (t) => {
  const { ntfy, dir } = await harness(t);

  for (const source of ['loop_wakeup', 'schedule_wakeup']) {
    await fireHook(dir, 'UserPromptSubmit', { prompt: 'check the deploy', source });
    await fireHook(dir, 'Stop', { last_assistant_message: `nothing new (${source})` });
  }

  assert.strictEqual(ntfy.received.length, 0, 'the user never asked for these turns');
});

test('a blocked /loop tick still asks for the user', async (t) => {
  // Skipping the completion push must not skip the one that needs a human.
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'UserPromptSubmit', {
    prompt: 'keep watching CI',
    source: 'loop_wakeup',
  });
  await fireHook(dir, 'Notification', {
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  });

  assert.deepStrictEqual(ntfy.received.map((n) => n.title), ['👀 Waiting']);
});

test('a headless run still reports its result', async (t) => {
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'UserPromptSubmit', { prompt: 'lint everything', source: 'sdk' });
  await fireHook(dir, 'Stop', { last_assistant_message: 'clean' });

  assert.deepStrictEqual(ntfy.received.map((n) => n.title), ['Completed']);
});

test('a machine turn that fails still reports the error', async (t) => {
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'UserPromptSubmit', { prompt: 'tick', source: 'loop_wakeup' });
  await fireHook(dir, 'StopFailure', { error: 'overloaded' });

  assert.deepStrictEqual(ntfy.received.map((n) => n.title), ['🚨 Error']);
});

test('UserPromptSubmit is silent but feeds the completion body', async (t) => {
  const { ntfy, dir } = await harness(t);

  const submit = await submitPrompt(dir, 'add a login page');

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
  const { ntfy, dir } = await harness(t);

  // Claude Code fires UserPromptSubmit for these too, tagged `source: "system"`.
  // firstPrompt is sticky, so storing one would poison every push for the rest
  // of the session.
  for (const injected of [
    '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>',
    '<system-reminder>Today is 2026-08-14.</system-reminder>',
    '<local-command-stdout>Enabled plan mode</local-command-stdout>',
    '<command-name>/plan</command-name>',
  ]) {
    await fireHook(dir, 'UserPromptSubmit', { prompt: injected, source: 'system' });
  }

  assert.ok(
    !fs.existsSync(path.join(dir, 'state', 'prompts.json')),
    'nothing worth remembering means nothing written'
  );

  await submitPrompt(dir, 'add a login page');
  await fireHook(dir, 'Stop', {});

  assert.match(ntfy.received[0].body, /Prompt: "add a login page"/);
  assert.ok(
    !ntfy.received[0].body.includes('task-notification'),
    'a real prompt must not be shadowed by injected text'
  );
});

test('injected turns are caught even without the source field', async (t) => {
  // Older Claude Code builds do not send `source`.
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'UserPromptSubmit', {
    prompt: '<system-reminder>be nice</system-reminder>',
  });
  await fireHook(dir, 'Stop', {});

  assert.ok(!ntfy.received[0].body.includes('system-reminder'));
});

test('an oversized prompt is capped before it is stored', async (t) => {
  const { dir } = await harness(t);

  await submitPrompt(dir, 'x'.repeat(50_000));

  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, 'state', 'prompts.json'), 'utf8')
  );
  assert.ok(
    Object.values(stored)[0].firstPrompt.length <= 400,
    'prompts.json must not accumulate multi-KB blobs'
  );
});

test('a session with no stored prompt falls back to the transcript', async (t) => {
  // Resumed sessions, and installs that happened mid-session, have no
  // prompts.json entry — the body used to read "(not available for this run)".
  const { ntfy, dir } = await harness(t);

  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    transcript,
    [
      // Claude Code's shape: type on the row, role nested, content sometimes a
      // bare string.
      JSON.stringify({ type: 'summary', summary: 'earlier work' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'fix the failing checkout test' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
      }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '<system-reminder>note</system-reminder>' },
      }),
      JSON.stringify({
        type: 'user',
        toolUseResult: { stdout: 'ok' },
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'now run the suite' }] },
      }),
    ].join('\n'),
    'utf8'
  );

  await fireHook(dir, 'Stop', {
    session_id: 'resumed-session',
    transcript_path: transcript,
    last_assistant_message: 'done',
  });

  assert.strictEqual(ntfy.received.length, 1);
  assert.match(ntfy.received[0].body, /Prompt: "fix the failing checkout test"/);
  assert.match(ntfy.received[0].body, /Latest: "now run the suite"/);
  assert.ok(
    !ntfy.received[0].body.includes('not available'),
    'the transcript was right there'
  );
  assert.ok(!ntfy.received[0].body.includes('system-reminder'));
  assert.ok(!ntfy.received[0].body.includes('tool_result'));
});

test('SessionEnd forgets the stored prompt and the session state', async (t) => {
  const { dir } = await harness(t);

  await submitPrompt(dir, 'ship the thing');
  await fireHook(dir, 'SessionEnd', { reason: 'clear' });

  const prompts = JSON.parse(
    fs.readFileSync(path.join(dir, 'state', 'prompts.json'), 'utf8')
  );
  assert.deepStrictEqual(prompts, {}, 'prompts.json must not grow forever');

  const sessions = JSON.parse(
    fs.readFileSync(path.join(dir, 'state', 'claude-sessions.json'), 'utf8')
  );
  assert.deepStrictEqual(sessions, {}, 'claude-sessions.json must not grow forever');
});

test('unknown events and BOM-prefixed stdin never break the agent', async (t) => {
  const { ntfy, dir } = await harness(t);

  const unknown = await fireHook(dir, 'PreToolUse', { tool_name: 'Bash' });
  assert.strictEqual(unknown.code, 0);
  assert.strictEqual(unknown.stdout.trim(), '');
  assert.strictEqual(ntfy.received.length, 0, 'unhandled events must be no-ops');

  // Hook stdin on Windows can carry a UTF-8 BOM, which JSON.parse rejects.
  const bom = await fireHook(dir, 'Stop', null, {
    raw: `﻿${JSON.stringify({
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

test('a payload with nothing in it still exits clean', async (t) => {
  const { ntfy, dir } = await harness(t);

  for (const raw of ['', '   ', 'not json at all', '{}', 'null']) {
    const result = await fireHook(dir, 'Stop', null, { raw });
    assert.strictEqual(result.code, 0, `raw payload ${JSON.stringify(raw)}`);
    assert.strictEqual(result.stdout.trim(), '');
  }

  // No session id to dedupe on, so each of these is treated as its own turn.
  assert.strictEqual(ntfy.received.length, 5);
  assert.ok(ntfy.received.every((n) => n.body.includes('Project: project')));
});

test('the event name falls back to the payload when argv is absent', async (t) => {
  const { ntfy, dir } = await harness(t);

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

test('a config from an older install still works', async (t) => {
  // Upgrades leave cursorping.config.json without waitingRepingMs.
  const { ntfy, dir } = await harness(t);
  const configFile = path.join(dir, 'cursorping.config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  delete config.waitingRepingMs;
  fs.writeFileSync(configFile, JSON.stringify(config), 'utf8');

  await submitPrompt(dir, 'go');
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  await fireHook(dir, 'Notification', { notification_type: 'permission_prompt' });

  assert.strictEqual(ntfy.received.length, 1, 'the built-in default applies');
});

test('an unreachable ntfy server never breaks the agent loop', async (t) => {
  const dir = installHooks('http://127.0.0.1:1');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = await fireHook(dir, 'Stop', { last_assistant_message: 'done' });

  assert.strictEqual(result.code, 0, 'a dead notifier must still exit 0');
  assert.strictEqual(result.stdout.trim(), '');
});

test('two sessions in the same project do not mute each other', async (t) => {
  const { ntfy, dir } = await harness(t);

  await fireHook(dir, 'UserPromptSubmit', {
    session_id: 'left',
    prompt: 'left task',
    source: 'user',
  });
  await fireHook(dir, 'UserPromptSubmit', {
    session_id: 'right',
    prompt: 'right task',
    source: 'user',
  });
  await fireHook(dir, 'Notification', {
    session_id: 'left',
    notification_type: 'permission_prompt',
  });
  await fireHook(dir, 'Notification', {
    session_id: 'right',
    notification_type: 'permission_prompt',
  });

  assert.strictEqual(ntfy.received.length, 2);
  assert.match(ntfy.received[0].body, /left task/);
  assert.match(ntfy.received[1].body, /right task/);
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

  const detailed = hookMessages.permissionMessage(
    'demo',
    null,
    'Claude Code',
    'Needs: approval'
  );
  assert.deepStrictEqual(
    extMessages.permissionMessage('demo', null, 'Claude Code', 'Needs: approval'),
    detailed
  );
  assert.deepStrictEqual(
    extMessages.stopMessage('error', 'demo', null, 'Claude Code', 'Error: rate_limit'),
    hookMessages.stopMessage('error', 'demo', null, 'Claude Code', 'Error: rate_limit')
  );

  // Omitting the label must reproduce the pre-0.4.0 body exactly.
  const unlabelled = hookMessages.permissionMessage('demo');
  assert.ok(!unlabelled.message.includes('Agent:'));
});
