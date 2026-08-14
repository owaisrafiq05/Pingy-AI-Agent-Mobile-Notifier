#!/usr/bin/env node
/**
 * Pingy hook entrypoint for Claude Code.
 *
 * Claude Code spawns: node "<abs>/pingy-claude.js" <EventName>
 * Payload JSON is piped on stdin.
 *
 * Observe-only: always exit 0 and never write to stdout. Claude Code gives exit
 * code 2 real meaning — on `Stop` it prevents the agent from stopping, on tool
 * events it blocks the call — so a notifier must never return anything else.
 * Stdout matters too: on `UserPromptSubmit` it is injected into the model's
 * context, so this script stays silent there (unlike the Cursor entrypoint,
 * which answers `beforeSubmitPrompt` with `{"continue":true}`).
 *
 * Two pushes matter, and Claude Code names both of them for us:
 *
 *   done    → `Stop` (turn ended) / `StopFailure` (turn died on an API error)
 *   waiting → `Notification`, whose `notification_type` says which dialog opened
 *
 * so none of Cursor's pending-gate state machine (lib/state.js, the extension
 * watcher, terminal corroboration) is needed here. What *is* needed is restraint:
 * Claude Code fires a `Notification` per dialog, and in `default` permission mode
 * an ordinary turn opens a dozen. lib/claudeState.js collapses those into one
 * "come back to your terminal" push per turn and keeps the 60s-idle notice from
 * contradicting a completion push. See that file for the rules.
 */
const os = require('os');
const path = require('path');
const { sendNotification } = require('./lib/notifier');
const { stopMessage, permissionMessage } = require('./lib/messages');
const {
  rememberPrompt,
  clearStoredPrompts,
  resolveChatContext,
  truncate,
} = require('./lib/context');
const { loadConfig } = require('./lib/config');
const {
  DEFAULT_REPING_MS,
  claimStop,
  claimWaiting,
  forgetSession,
  noteTurnStart,
  pruneSessions,
  readSessions,
  turnIsMachineDriven,
  writeSessions,
} = require('./lib/claudeState');

/** Labels the push so you can tell Cursor and Claude Code apart. */
const SOURCE = 'Claude Code';

/**
 * Notification types that mean "the agent cannot continue without you", mapped
 * to the phrasing used when Claude Code sends no message of its own.
 *
 * `permission_prompt` covers every blocking dialog in the main session — tool
 * approval, plan approval, a question the agent asked. `worker_permission_prompt`
 * is the same thing raised by a teammate session, and the elicitation dialogs are
 * an MCP server asking the user directly.
 *
 * `agent_completed` is deliberately excluded — `Stop` already covers that and
 * handling both would double-push. `auth_success`, `push_notification` and the
 * computer-use notices are not blocks.
 */
const WAITING_TYPES = new Map([
  ['permission_prompt', 'Claude needs your approval'],
  ['worker_permission_prompt', 'A teammate session needs your approval'],
  ['agent_needs_input', 'Claude needs your input'],
  ['idle_prompt', 'Claude is waiting for your input'],
  ['elicitation_dialog', 'An MCP server needs your input'],
  ['elicitation_url_dialog', 'An MCP server needs you to open a URL'],
]);

/**
 * `UserPromptSubmit.source` names who authored the turn. Anything other than a
 * person at the keyboard ("user") or a headless run ("sdk") is the harness
 * talking to itself — background-task notices, system reminders, slash-command
 * output — and storing one is worse than storing nothing: `firstPrompt` is
 * sticky, so a wall of XML would head every push for the rest of the session.
 */
const TYPED_PROMPT_SOURCES = new Set(['user', 'sdk']);

/** Older Claude Code builds omit `source`; fall back to sniffing the text. */
const INJECTED_PREFIXES = [
  '<task-notification',
  '<system-reminder',
  '<local-command-stdout',
  '<local-command-stderr',
  '<command-name',
  '<command-message',
];

/** Longest prompt worth persisting; the body truncates to 180 chars anyway. */
const MAX_STORED_PROMPT = 400;

/** Room for "Claude needs your permission to use Bash" and a little more. */
const MAX_DETAIL = 140;

function userTypedPrompt(prompt, source) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  if (source && !TYPED_PROMPT_SOURCES.has(source)) return null;
  const head = text.slice(0, 40).toLowerCase();
  if (INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    return null;
  }
  return text.slice(0, MAX_STORED_PROMPT);
}

const STATE_DIR = path.join(__dirname, 'state');
const SESSIONS_FILE = path.join(STATE_DIR, 'claude-sessions.json');

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
    path.join(__dirname, 'cursorping.config.json'),
    path.join(os.homedir(), '.claude', 'hooks', 'pingy', 'cursorping.config.json'),
    // Last resort: a Cursor-only install still has the topic, and setup writes
    // the same topic to both, so falling through here is always correct.
    path.join(os.homedir(), '.cursor', 'hooks', 'cursorping.config.json')
  );
  return candidates;
}

function projectName(cwd) {
  const root = String(cwd || '');
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
    // Never let a stalled pipe hold the agent loop open.
    setTimeout(() => resolve(data), 2000);
  });
}

/** Hook stdin on Windows can carry a UTF-8 BOM, which JSON.parse rejects. */
function parsePayload(raw) {
  const cleaned = String(raw || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!cleaned) return {};
  try {
    const parsed = JSON.parse(cleaned);
    // `null` and bare scalars parse fine and then throw on first field access.
    // Exit code 1 out of a Stop hook is a visible error in the user's terminal.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.error('pingy: invalid JSON on stdin', e);
    return {};
  }
}

/**
 * What the user is being asked, straight from Claude Code where it exists
 * ("Claude needs your permission to use Bash"), otherwise our own phrasing for
 * that notification type.
 */
function waitingDetail(payload, kind) {
  const message = String(payload.message || '').trim();
  const text = message || WAITING_TYPES.get(kind) || '';
  return text ? `Needs: ${truncate(text, MAX_DETAIL)}` : null;
}

/**
 * Background work keeps the session alive after the turn ends, so "task's done"
 * on its own would be a half-truth.
 */
function backgroundDetail(payload) {
  const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
  const live = tasks.filter((task) => {
    const status = String(task?.status || '').toLowerCase();
    return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
  });
  if (!live.length) return null;
  return `Note: ${live.length} background task${live.length === 1 ? '' : 's'} still running`;
}

function errorDetail(payload) {
  const code = String(payload.error || 'unknown').trim();
  const details = String(payload.error_details || '').trim();
  const text = details ? `${code} — ${details}` : code;
  return `Error: ${truncate(text, MAX_DETAIL)}`;
}

/**
 * `Stop` fires again when another Stop hook forces the agent onward, and once
 * more when background work wakes the session. The last assistant message is the
 * cheapest thing that differs between a genuine second turn and a repeat.
 */
function stopSignature(payload) {
  return truncate(String(payload.last_assistant_message || ''), 200);
}

async function main() {
  const payload = parsePayload(await readStdin());
  const eventName = process.argv[2] || payload.hook_event_name || '';
  const config = loadConfig(configCandidates());
  const project = projectName(payload.cwd);
  const sessionId = payload.session_id || '';
  const now = Date.now();
  // context.js is keyed on Cursor's field name; adapt rather than fork it.
  const chat = () =>
    resolveChatContext({
      conversation_id: sessionId,
      transcript_path: payload.transcript_path,
    });

  const sessions = readSessions(SESSIONS_FILE);
  let stateChanged = false;

  try {
    if (eventName === 'UserPromptSubmit') {
      // Even a machine-authored turn is a turn: recording it is what lets the
      // next block ping immediately and stops `/loop` ticks from pushing.
      noteTurnStart(sessions, sessionId, { now, source: payload.source });
      stateChanged = true;

      const typed = userTypedPrompt(payload.prompt, payload.source);
      if (typed) {
        rememberPrompt(sessionId, typed);
      }
    } else if (eventName === 'Notification') {
      const kind = payload.notification_type;
      // Builds that predate `notification_type` send every notice here; without
      // a type we cannot tell a block from an auth notice, so we stay quiet.
      if (WAITING_TYPES.has(kind)) {
        const send = claimWaiting(sessions, sessionId, {
          now,
          kind,
          repingMs: config.waitingRepingMs ?? DEFAULT_REPING_MS,
        });
        stateChanged = true;
        if (send) {
          await sendNotification(
            config.ntfyTopic,
            permissionMessage(project, chat(), SOURCE, waitingDetail(payload, kind)),
            config.serverUrl
          );
        }
      }
    } else if (eventName === 'Stop' || eventName === 'StopFailure') {
      const failed = eventName === 'StopFailure';
      const send = claimStop(sessions, sessionId, {
        now,
        signature: `${eventName}:${stopSignature(payload)}`,
      });
      stateChanged = true;

      // A `/loop` tick or a scheduled wake-up ends a turn the user never asked
      // for. Pushing "task's done" on every tick is noise; a block still pushes.
      const machineTurn = !failed && turnIsMachineDriven(sessions, sessionId);

      if (send && !machineTurn) {
        await sendNotification(
          config.ntfyTopic,
          stopMessage(
            failed ? 'error' : 'completed',
            project,
            chat(),
            SOURCE,
            failed ? errorDetail(payload) : backgroundDetail(payload)
          ),
          config.serverUrl
        );
      }
    } else if (eventName === 'SessionEnd') {
      clearStoredPrompts(sessionId);
      forgetSession(sessions, sessionId);
      stateChanged = true;
    }
  } catch (e) {
    console.error('pingy: unexpected error', e);
  }

  if (stateChanged) {
    pruneSessions(sessions, now);
    writeSessions(SESSIONS_FILE, sessions);
  }

  process.exit(0);
}

main();
