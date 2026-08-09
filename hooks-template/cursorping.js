#!/usr/bin/env node
/**
 * CursorPing hook entrypoint.
 * Cursor spawns: node ./hooks/cursorping.js <eventName>
 * Payload JSON is piped on stdin.
 *
 * Observe-only: always exit 0, never emit a permission decision, and never
 * block the agent. Emitting a decision here would override Cursor's own
 * approval flow, which is exactly the thing we are trying to observe.
 *
 * On gate open we only record pending state. Waiting notifications are sent by
 * the extension watcher (it can tell a slow auto-run command apart from a real
 * Run/Skip prompt). Hooks must not push "waiting" on their own — a gate that
 * stays open while a command runs is not the same as waiting for approval.
 */
const path = require('path');
const { sendNotification } = require('./lib/notifier');
const { stopMessage } = require('./lib/messages');
const {
  rememberPrompt,
  resolveChatContext,
} = require('./lib/context');
const { markPending, clearPending } = require('./lib/state');
const { loadConfig } = require('./lib/config');

/** Labels the push so you can tell Cursor and Claude Code apart. */
const SOURCE = 'Cursor';

/**
 * Events that fire immediately before a gate where Cursor may ask the user to
 * approve something. Cursor has no event for "approval dialog opened", so the
 * gate opening plus a short silent gap is the signal we have.
 */
const GATE_EVENTS = new Set([
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
]);

/**
 * Events that prove the agent is no longer blocked: the user approved (the
 * tool ran), rejected (postToolUseFailure with permission_denied), or the loop
 * moved on for some other reason.
 */
const RESOLVE_EVENTS = new Set([
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'afterMCPExecution',
  'afterFileEdit',
  'afterAgentResponse',
  'afterAgentThought',
  'subagentStop',
]);

function configCandidates() {
  const candidates = [];
  if (process.env.CURSORPING_CONFIG) {
    candidates.push(process.env.CURSORPING_CONFIG);
  }
  // Tests isolate state under a temp install — prefer that install's config
  // so we never POST to the developer's real ntfy topic during the suite.
  if (process.env.CURSORPING_STATE_DIR) {
    candidates.push(
      path.join(process.env.CURSORPING_STATE_DIR, '..', 'cursorping.config.json')
    );
  }
  candidates.push(
    path.join(require('os').homedir(), '.cursor', 'hooks', 'cursorping.config.json'),
    path.join(__dirname, 'cursorping.config.json')
  );
  return candidates;
}

function projectName(workspaceRoots) {
  const root = workspaceRoots?.[0] ?? '';
  if (!root) return 'project';
  return path.basename(root.replace(/[/\\]+$/, '')) || 'project';
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

/**
 * Cursor on Windows often prefixes hook stdin with a UTF-8 BOM. That makes
 * JSON.parse throw, which used to drop conversation_id and silently disable
 * every permission / completion notification.
 */
function parsePayload(raw) {
  const cleaned = String(raw || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!cleaned) return {};
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('cursorping: invalid JSON on stdin', e);
    return {};
  }
}

/** Best-effort description of what the gate is about, for terminal matching. */
function gateMeta(eventName, payload) {
  const toolInput = payload.tool_input;
  const command =
    payload.command ??
    (toolInput && typeof toolInput === 'object' ? toolInput.command : null) ??
    null;

  return {
    event: eventName,
    toolName: payload.tool_name ?? (payload.command ? 'Shell' : null),
    command: typeof command === 'string' ? command : null,
    toolUseId: payload.tool_use_id ?? null,
    project: projectName(payload.workspace_roots),
  };
}

async function main() {
  const eventName = process.argv[2] || '';
  const config = loadConfig(configCandidates());
  const payload = parsePayload(await readStdin());
  const project = projectName(payload.workspace_roots);

  try {
    if (eventName === 'beforeSubmitPrompt') {
      rememberPrompt(payload.conversation_id, payload.prompt);
      clearPending(payload.conversation_id);
      process.stdout.write(JSON.stringify({ continue: true }));
    } else if (GATE_EVENTS.has(eventName)) {
      markPending(payload.conversation_id, gateMeta(eventName, payload));
    } else if (RESOLVE_EVENTS.has(eventName)) {
      clearPending(payload.conversation_id);
    } else if (eventName === 'stop') {
      clearPending(payload.conversation_id);
      const chat = resolveChatContext(payload);
      await sendNotification(
        config.ntfyTopic,
        stopMessage(payload.status, project, chat, SOURCE),
        config.serverUrl
      );
    }
  } catch (e) {
    console.error('cursorping: unexpected error', e);
  }

  process.exit(0);
}

main();
