/**
 * Notification copy for Pingy (mirrors src/messages.ts).
 */

/**
 * `source` names the agent that fired the ping ("Cursor" / "Claude Code") so a
 * push is attributable when both agents are running in the same project. It is
 * optional: omitting it reproduces the pre-0.4.0 body exactly.
 *
 * `detail` is a caller-formatted line ("Needs: …", "Error: …") appended last.
 * Claude Code hands the hook the reason it stopped or blocked, and on a phone
 * that line is the difference between an actionable push and a vague buzz.
 */
function formatContextBody(base, project, chat, source, detail) {
  const lines = [base];
  lines.push('');
  lines.push(`Project: ${project || 'your project'}`);
  if (source) {
    lines.push(`Agent: ${source}`);
  }

  if (chat?.firstPrompt) {
    lines.push(`Prompt: "${chat.firstPrompt}"`);
  }
  if (
    chat?.latestPrompt &&
    chat.latestPrompt !== chat.firstPrompt
  ) {
    lines.push(`Latest: "${chat.latestPrompt}"`);
  }
  if (!chat?.firstPrompt && !chat?.latestPrompt) {
    lines.push('Prompt: (not available for this run)');
  }
  if (detail) {
    lines.push(detail);
  }
  return lines.join('\n');
}

function stopMessage(status, project, chat, source, detail) {
  const name = project || 'your project';
  const byStatus = {
    completed: {
      title: 'Completed',
      message: formatContextBody(
        "Your agent cooked. Task's done 🔥",
        name,
        chat,
        source,
        detail
      ),
      priority: 'default',
      tags: ['fire'],
    },
    error: {
      title: '🚨 Error',
      message: formatContextBody(
        'Uh oh… your agent hit a snag 😬',
        name,
        chat,
        source,
        detail
      ),
      priority: 'high',
      tags: ['rotating_light', 'x'],
    },
    aborted: {
      title: 'Stopped',
      message: formatContextBody(
        'That run ended early — cancelled or interrupted.',
        name,
        chat,
        source,
        detail
      ),
      priority: 'low',
      tags: ['no_entry_sign'],
    },
  };
  return byStatus[status] ?? byStatus.completed;
}

/**
 * Sent when the agent is blocked on an approval prompt.
 */
function permissionMessage(project, chat, source, detail) {
  return {
    title: '👀 Waiting',
    message: formatContextBody(
      'Hey, your agent needs you',
      project || 'your project',
      chat,
      source,
      detail
    ),
    priority: 'urgent',
    tags: ['hand'],
  };
}

/** @deprecated Use permissionMessage */
function needsYouMessage(project, chat, source) {
  return permissionMessage(project, chat, source);
}

function testMessage(project) {
  const name = project || 'your project';
  return {
    title: 'Pingy is live',
    message: formatContextBody(
      "Pairing works. You'll get a ping when the agent finishes, waits, or hits an error.",
      name,
      null
    ),
    priority: 'default',
    tags: ['bell', 'blush'],
  };
}

module.exports = {
  stopMessage,
  permissionMessage,
  needsYouMessage,
  testMessage,
  formatContextBody,
};
