const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state');
const PROMPTS_FILE = path.join(STATE_DIR, 'prompts.json');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readPrompts() {
  try {
    const raw = fs.readFileSync(PROMPTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writePrompts(data) {
  ensureStateDir();
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Remember the user's prompt for a conversation.
 * Keeps the first prompt forever and always updates the latest.
 */
function rememberPrompt(conversationId, promptText) {
  if (!conversationId || !promptText) return;
  const cleaned = cleanPromptText(promptText);
  if (!cleaned) return;

  const data = readPrompts();
  const prior = data[conversationId] || {};
  data[conversationId] = {
    firstPrompt: prior.firstPrompt || cleaned,
    latestPrompt: cleaned,
    updatedAt: Date.now(),
  };
  writePrompts(data);
}

function getStoredPrompts(conversationId) {
  if (!conversationId) return null;
  const data = readPrompts();
  return data[conversationId] || null;
}

function clearStoredPrompts(conversationId) {
  if (!conversationId) return;
  const data = readPrompts();
  if (data[conversationId]) {
    delete data[conversationId];
    writePrompts(data);
  }
}

function cleanPromptText(text) {
  let s = String(text || '');
  // Strip Cursor wrapper tags when present
  const query = s.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (query) s = query[1];
  s = s.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function truncate(text, max = 180) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trim()}…`;
}

/**
 * Text of one transcript line, if it is something the user typed.
 *
 * Cursor tags the row itself (`{role:"user", message:{content:[…]}}`); Claude
 * Code tags it with `type` and nests the role (`{type:"user", message:{role,
 * content}}`), where `content` may be a bare string. Reading only Cursor's shape
 * is why Claude Code pushes used to say "Prompt: (not available for this run)"
 * whenever prompts.json had no entry — a resumed session, or an install that
 * happened mid-session.
 */
function userTextFromTranscriptRow(row) {
  if (!row || typeof row !== 'object') return null;

  const isUser =
    row.role === 'user' || row.type === 'user' || row.message?.role === 'user';
  if (!isUser) return null;

  // Tool results and harness injections ride in on user-role rows. They are not
  // what the user asked for, and `firstPrompt` is sticky once stored.
  if (row.isMeta || row.isCompactSummary || row.toolUseResult !== undefined) {
    return null;
  }

  const content = row.message?.content ?? row.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((p) => p && p.type === 'tool_result')) return null;
    text = content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }

  const cleaned = cleanPromptText(text);
  if (!cleaned || isInjectedPrompt(cleaned)) return null;
  return cleaned;
}

/** Harness-injected turns look like user messages but nobody typed them. */
function isInjectedPrompt(text) {
  const head = String(text || '').trimStart().slice(0, 40).toLowerCase();
  return [
    '<task-notification',
    '<system-reminder',
    '<local-command-stdout',
    '<local-command-stderr',
    '<command-name',
    '<command-message',
    '<user-prompt-submit-hook',
    'caveat: the messages below were generated',
  ].some((prefix) => head.startsWith(prefix));
}

function readTranscriptRows(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    return fs
      .readFileSync(transcriptPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Pull the first user message text from a transcript jsonl file.
 */
function firstUserPromptFromTranscript(transcriptPath) {
  for (const row of readTranscriptRows(transcriptPath)) {
    const text = userTextFromTranscriptRow(row);
    if (text) return text;
  }
  return null;
}

/**
 * Latest user message from transcript (last user row).
 */
function latestUserPromptFromTranscript(transcriptPath) {
  let latest = null;
  for (const row of readTranscriptRows(transcriptPath)) {
    const text = userTextFromTranscriptRow(row);
    if (text) latest = text;
  }
  return latest;
}

/**
 * Resolve the best context snippet for a notification.
 * Prefer: stored first/latest → transcript first/latest.
 */
function resolveChatContext(payload) {
  const conversationId = payload?.conversation_id;
  const transcriptPath = payload?.transcript_path || null;
  const stored = getStoredPrompts(conversationId);

  const first =
    stored?.firstPrompt ||
    firstUserPromptFromTranscript(transcriptPath) ||
    null;
  const latest =
    stored?.latestPrompt ||
    latestUserPromptFromTranscript(transcriptPath) ||
    first;

  return {
    firstPrompt: first ? truncate(first) : null,
    latestPrompt: latest ? truncate(latest) : null,
  };
}

module.exports = {
  rememberPrompt,
  getStoredPrompts,
  clearStoredPrompts,
  resolveChatContext,
  cleanPromptText,
  isInjectedPrompt,
  truncate,
  firstUserPromptFromTranscript,
  latestUserPromptFromTranscript,
};
