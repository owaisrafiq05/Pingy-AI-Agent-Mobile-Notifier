/**
 * Post a notification to ntfy. Never throws — failures are logged only
 * so a network hiccup cannot hang or break Cursor's agent loop.
 *
 * Uses JSON publish so emoji titles (✅ / 👀 / 🚨) survive — HTTP headers
 * are Latin-1 ByteStrings and would strip them.
 */

async function sendNotification(
  topic,
  { title, message, priority = 'default', tags = [] },
  serverUrl = 'https://ntfy.sh'
) {
  if (!topic) {
    console.error('pingy: notify skipped - no topic configured');
    return;
  }

  const base = String(serverUrl).replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const priorityMap = {
    min: 1,
    low: 2,
    default: 3,
    high: 4,
    max: 5,
    urgent: 5,
  };
  const priorityNum =
    typeof priority === 'number'
      ? priority
      : priorityMap[String(priority)] ?? 3;

  try {
    await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        title: title ?? '',
        message: message ?? '',
        priority: priorityNum,
        tags: tags && tags.length ? tags : undefined,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    console.error('pingy: notify failed', e);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendNotification };
