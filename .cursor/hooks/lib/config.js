/**
 * Shared config resolution for the hook entrypoints.
 *
 * Both agents (Cursor and Claude Code) read the same `cursorping.config.json`
 * shape and — after a single setup — the same ntfy topic, so one pairing covers
 * both. Only the search order differs, which is why the candidate list is
 * supplied by the caller instead of being hardcoded here.
 */
const fs = require('fs');

const DEFAULTS = {
  ntfyTopic: '',
  serverUrl: 'https://ntfy.sh',
  pendingTimeoutMs: 2000,
};

/**
 * First candidate holding a non-empty ntfyTopic wins. Unreadable or malformed
 * files are skipped rather than thrown, so a half-written config can never
 * break the agent loop.
 *
 * @param {string[]} candidates ordered absolute paths
 */
function loadConfig(candidates = []) {
  for (const file of candidates) {
    if (!file) continue;
    try {
      if (!fs.existsSync(file)) continue;
      // Windows editors like to prefix JSON with a BOM, which JSON.parse rejects.
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      if (cfg?.ntfyTopic) {
        return {
          ntfyTopic: cfg.ntfyTopic,
          serverUrl: cfg.serverUrl || DEFAULTS.serverUrl,
          pendingTimeoutMs: cfg.pendingTimeoutMs ?? DEFAULTS.pendingTimeoutMs,
        };
      }
    } catch {
      /* try next */
    }
  }
  return { ...DEFAULTS };
}

module.exports = { loadConfig, DEFAULTS };
