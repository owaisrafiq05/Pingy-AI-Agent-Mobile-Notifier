/**
 * Notification copy for Pingy.
 */

function formatContextBody(base, project, chat) {
  const lines = [base];
  lines.push('');
  lines.push(`Project: ${project || 'your project'}`);

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
  return lines.join('\n');
}

function stopMessage(status, project, chat) {
  const name = project || 'your project';
  const byStatus = {
    completed: {
      title: 'Completed',
      message: formatContextBody(
        "Your agent cooked. Task's done 🔥",
        name,
        chat
      ),
      priority: 'default',
      tags: ['fire'],
    },
    error: {
      title: '🚨 Error',
      message: formatContextBody(
        'Uh oh… your agent hit a snag 😬',
        name,
        chat
      ),
      priority: 'high',
      tags: ['rotating_light', 'x'],
    },
    aborted: {
      title: 'Stopped',
      message: formatContextBody(
        'That run ended early — cancelled or interrupted.',
        name,
        chat
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
function permissionMessage(project, chat) {
  return {
    title: '👀 Waiting',
    message: formatContextBody(
      'Hey, your agent needs you',
      project || 'your project',
      chat
    ),
    priority: 'urgent',
    tags: ['hand'],
  };
}

/** @deprecated Use permissionMessage */
function needsYouMessage(project, chat) {
  return permissionMessage(project, chat);
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
