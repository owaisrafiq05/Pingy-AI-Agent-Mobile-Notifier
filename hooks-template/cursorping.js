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
const {
  markPending,
  clearPending,
  clearPendingIfNotPromptable,
  claimCompletion,
} = require('./lib/state');
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
 * The subset Cursor can actually stop and ask about: running a shell command and
 * calling an MCP tool.
 *
 * `preToolUse` fires for every tool the agent uses — reads, searches, edits —
 * and Cursor applies those itself, so an open `preToolUse` gate only ever means
 * "busy". Recording that here (rather than re-deriving it in the extension) keeps
 * the judgement next to the event names it depends on.
 */
const PROMPTABLE_EVENTS = new Set(['beforeShellExecution', 'beforeMCPExecution']);

/**
 * Hard proof the gate closed: the tool ran, failed, or the shell/MCP call
 * finished. These always clear pending.
 */
const HARD_RESOLVE_EVENTS = new Set([
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'afterMCPExecution',
]);

/**
 * Soft activity that can still happen while Run/Skip is on screen. Must not
 * clear a promptable shell/MCP gate or waiting alerts are dropped.
 */
const SOFT_RESOLVE_EVENTS = new Set([
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
    promptable: PROMPTABLE_EVENTS.has(eventName),
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
    } else if (HARD_RESOLVE_EVENTS.has(eventName)) {
      clearPending(payload.conversation_id);
    } else if (SOFT_RESOLVE_EVENTS.has(eventName)) {
      clearPendingIfNotPromptable(payload.conversation_id);
    } else if (eventName === 'stop') {
      clearPending(payload.conversation_id);
      // Cursor runs project + user hooks together; both hit this path. Claim
      // once so the same turn does not push "Completed" twice.
      const stopKey =
        payload.conversation_id ||
        payload.generation_id ||
        payload.session_id ||
        '';
      if (!claimCompletion(stopKey)) {
        process.exit(0);
        return;
      }
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
