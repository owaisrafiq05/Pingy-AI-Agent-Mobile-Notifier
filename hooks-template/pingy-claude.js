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
 * Unlike Cursor, Claude Code has a real `Notification` event that fires exactly
 * when the agent is blocked on you. That means none of the pending-gate state
 * machine (lib/state.js, the extension watcher, terminal corroboration) is
 * needed here — we push directly and there is no timing heuristic to get wrong.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { sendNotification } = require('./lib/notifier');
const { stopMessage, permissionMessage } = require('./lib/messages');
const {
  rememberPrompt,
  clearStoredPrompts,
  resolveChatContext,
} = require('./lib/context');
const { loadConfig } = require('./lib/config');

/** Labels the push so you can tell Cursor and Claude Code apart. */
const SOURCE = 'Claude Code';

/**
 * Notification types that mean "the agent cannot continue without you".
 * `agent_completed` is deliberately excluded — `Stop` already covers that and
 * handling both would double-push. Auth and elicitation notices are noise.
 */
const WAITING_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input',
]);

/**
 * UserPromptSubmit also fires for turns the harness injects — background task
 * notifications, system reminders, slash-command output. Those are not what the
 * user typed, and storing one is worse than storing nothing: `firstPrompt` is
 * sticky, so a wall of XML would head every push for the rest of the session.
 */
const INJECTED_PREFIXES = [
  '<task-notification',
  '<system-reminder',
  '<local-command-stdout',
  '<command-name',
  '<command-message',
];

/** Longest prompt worth persisting; the body truncates to 180 chars anyway. */
const MAX_STORED_PROMPT = 400;

function userTypedPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const head = text.slice(0, 40).toLowerCase();
  if (INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    return null;
  }
  return text.slice(0, MAX_STORED_PROMPT);
}

/** Suppress a second waiting push for the same session inside this window. */
const WAITING_DEDUPE_MS = 10_000;
const STATE_DIR = path.join(__dirname, 'state');
const WAITING_FILE = path.join(STATE_DIR, 'claude-waiting.json');

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
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('pingy: invalid JSON on stdin', e);
    return {};
  }
}

/**
 * `permission_prompt` and `agent_needs_input` can arrive back-to-back for the
 * same block. Claim the push so only the first one through actually sends.
 */
function claimWaiting(sessionId, now = Date.now()) {
  if (!sessionId) return true;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(WAITING_FILE, 'utf8')) || {};
  } catch {
    state = {};
  }

  const last = state[sessionId];
  if (typeof last === 'number' && now - last < WAITING_DEDUPE_MS) {
    return false;
  }

  // Drop stale sessions so the file cannot grow without bound.
  for (const [id, ts] of Object.entries(state)) {
    if (typeof ts !== 'number' || now - ts > 24 * 60 * 60 * 1000) {
      delete state[id];
    }
  }
  state[sessionId] = now;

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(WAITING_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* best effort — a failed claim must not suppress the notification */
  }
  return true;
}

async function main() {
  const payload = parsePayload(await readStdin());
  const eventName = process.argv[2] || payload.hook_event_name || '';
  const config = loadConfig(configCandidates());
  const project = projectName(payload.cwd);
  // context.js is keyed on Cursor's field name; adapt rather than fork it.
  const chat = () =>
    resolveChatContext({
      conversation_id: payload.session_id,
      transcript_path: payload.transcript_path,
    });

  try {
    if (eventName === 'UserPromptSubmit') {
      const typed = userTypedPrompt(payload.prompt);
      if (typed) {
        rememberPrompt(payload.session_id, typed);
      }
    } else if (eventName === 'Notification') {
      if (
        WAITING_TYPES.has(payload.notification_type) &&
        claimWaiting(payload.session_id)
      ) {
        await sendNotification(
          config.ntfyTopic,
          permissionMessage(project, chat(), SOURCE),
          config.serverUrl
        );
      }
    } else if (eventName === 'Stop') {
      await sendNotification(
        config.ntfyTopic,
        stopMessage('completed', project, chat(), SOURCE),
        config.serverUrl
      );
    } else if (eventName === 'StopFailure') {
      await sendNotification(
        config.ntfyTopic,
        stopMessage('error', project, chat(), SOURCE),
        config.serverUrl
      );
    } else if (eventName === 'SessionEnd') {
      clearStoredPrompts(payload.session_id);
    }
  } catch (e) {
    console.error('pingy: unexpected error', e);
  }

  process.exit(0);
}

main();
