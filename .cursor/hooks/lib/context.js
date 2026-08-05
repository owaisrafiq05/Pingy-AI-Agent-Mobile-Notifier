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
 * Pull the first user message text from a Cursor transcript jsonl file.
 */
function firstUserPromptFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.role !== 'user') continue;
      const parts = row.message?.content;
      if (!Array.isArray(parts)) continue;
      const texts = parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text);
      const cleaned = cleanPromptText(texts.join('\n'));
      if (cleaned) return cleaned;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Latest user message from transcript (last user role line).
 */
function latestUserPromptFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let latest = null;
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.role !== 'user') continue;
      const parts = row.message?.content;
      if (!Array.isArray(parts)) continue;
      const texts = parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text);
      const cleaned = cleanPromptText(texts.join('\n'));
      if (cleaned) latest = cleaned;
    }
    return latest;
  } catch {
    return null;
  }
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
  truncate,
  firstUserPromptFromTranscript,
};
