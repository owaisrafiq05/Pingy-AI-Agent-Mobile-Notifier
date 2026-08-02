/**
 * Human-friendly notification copy for CursorPing.
 * Titles stay ASCII-safe (ntfy header ByteString limits).
 */

function stopMessage(status, project) {
  const name = project || 'your project';
  const byStatus = {
    completed: {
      title: `All done on ${name}`,
      message:
        'Your Cursor agent just finished. Swing back when you can and check the results.',
      priority: 'default',
      tags: ['white_check_mark', 'tada'],
    },
    error: {
      title: `Heads up - snag on ${name}`,
      message:
        'The agent hit an error and stopped. A quick look in Cursor should tell you what went wrong.',
      priority: 'high',
      tags: ['x', 'rotating_light'],
    },
    aborted: {
      title: `Run stopped on ${name}`,
      message:
        'That session ended early (you cancelled it, or something interrupted it). No rush.',
      priority: 'low',
      tags: ['no_entry_sign'],
    },
  };
  return byStatus[status] ?? byStatus.completed;
}

function needsYouMessage(project) {
  const name = project || 'your project';
  return {
    title: `Got a second? ${name} needs you`,
    message:
      'Cursor looks stuck waiting for your approval on a command. Open the IDE and tap Allow when you can.',
    priority: 'urgent',
    tags: ['wave', 'hourglass'],
  };
}

function testMessage(project) {
  const name = project || 'your project';
  return {
    title: `Hey - CursorPing is live`,
    message: `Pairing works for ${name}. You'll get a friendly ping here when the agent finishes or needs you.`,
    priority: 'default',
    tags: ['blush', 'bell'],
  };
}

module.exports = { stopMessage, needsYouMessage, testMessage };
