/**
 * Post a notification to ntfy. Never throws — failures are logged only
 * so a network hiccup cannot hang or break Cursor's agent loop.
 */

/** ntfy header values must be Latin-1 ByteStrings (Node fetch restriction). */
function toHeaderValue(value) {
  return String(value ?? '')
    .replace(/[\u2013\u2014\u2015]/g, '-') // en/em dashes
    .replace(/[^\x20-\x7E]/g, '');
}

async function sendNotification(
  topic,
  { title, message, priority = 'default', tags = [] },
  serverUrl = 'https://ntfy.sh'
) {
  if (!topic) {
    console.error('cursorping: notify skipped - no topic configured');
    return;
  }

  const base = String(serverUrl).replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const headers = {
      Title: toHeaderValue(title),
      Priority: String(priority),
    };
    if (tags && tags.length) {
      headers.Tags = tags.join(',');
    }

    await fetch(`${base}/${topic}`, {
      method: 'POST',
      headers,
      body: message ?? '',
      signal: controller.signal,
    });
  } catch (e) {
    console.error('cursorping: notify failed', e);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendNotification };
