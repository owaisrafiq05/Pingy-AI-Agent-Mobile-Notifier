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
 * On gate open we schedule a tiny detached checker. If the gate is still open
 * after pendingTimeoutMs, that checker sends the one permission notification.
 * Approving/rejecting clears the gate first, so allowlisted fast commands stay
 * silent.
 */
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { sendNotification } = require('./lib/notifier');
const { stopMessage } = require('./lib/messages');
const {
  rememberPrompt,
  resolveChatContext,
} = require('./lib/context');
const { markPending, clearPending } = require('./lib/state');

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
 * Tools that almost never show an Allow prompt. Scheduling a permission check
 * for these would mostly create noise, so they only clear state when they end.
 */
const QUIET_PRE_TOOL = new Set([
  'Read',
  'Grep',
  'Glob',
  'SemSearch',
  'AwaitShell',
  'ReadLints',
  'TodoWrite',
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

function loadConfig() {
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

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      if (cfg?.ntfyTopic) {
        return {
          ntfyTopic: cfg.ntfyTopic,
          serverUrl: cfg.serverUrl || 'https://ntfy.sh',
          pendingTimeoutMs: cfg.pendingTimeoutMs ?? 2000,
        };
      }
    } catch {
      /* try next */
    }
  }
  return {
    ntfyTopic: '',
    serverUrl: 'https://ntfy.sh',
    pendingTimeoutMs: 2000,
  };
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
  };
}

function shouldSchedulePermissionCheck(eventName, payload) {
  if (eventName === 'beforeShellExecution' || eventName === 'beforeMCPExecution') {
    return true;
  }
  if (eventName === 'preToolUse') {
    const tool = payload.tool_name || '';
    return !QUIET_PRE_TOOL.has(tool);
  }
  return false;
}

/**
 * Fire-and-forget: parent hook exits immediately; this child waits and notifies
 * only if Cursor is still waiting on Run / Skip.
 */
function schedulePermissionCheck(conversationId, delayMs) {
  if (!conversationId) return;
  const script = path.join(__dirname, 'lib', 'permissionCheck.js');
  try {
    const child = spawn(
      process.execPath,
      [script, String(delayMs), conversationId],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    child.unref();
  } catch (e) {
    console.error('cursorping: failed to schedule permission check', e);
  }
}

async function main() {
  const eventName = process.argv[2] || '';
  const config = loadConfig();
  const payload = parsePayload(await readStdin());
  const project = projectName(payload.workspace_roots);
  const delayMs = config.pendingTimeoutMs ?? 2000;

  try {
    if (eventName === 'beforeSubmitPrompt') {
      rememberPrompt(payload.conversation_id, payload.prompt);
      clearPending(payload.conversation_id);
      process.stdout.write(JSON.stringify({ continue: true }));
    } else if (GATE_EVENTS.has(eventName)) {
      markPending(payload.conversation_id, gateMeta(eventName, payload));
      if (shouldSchedulePermissionCheck(eventName, payload)) {
        schedulePermissionCheck(payload.conversation_id, delayMs);
      }
    } else if (RESOLVE_EVENTS.has(eventName)) {
      clearPending(payload.conversation_id);
    } else if (eventName === 'stop') {
      clearPending(payload.conversation_id);
      const chat = resolveChatContext(payload);
      await sendNotification(
        config.ntfyTopic,
        stopMessage(payload.status, project, chat),
        config.serverUrl
      );
    }
  } catch (e) {
    console.error('cursorping: unexpected error', e);
  }

  process.exit(0);
}

main();
