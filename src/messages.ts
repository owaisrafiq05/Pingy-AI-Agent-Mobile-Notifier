/** Human-friendly notification copy (mirrors hooks-template/lib/messages.js). */

export interface NotifyCopy {
  title: string;
  message: string;
  priority: string;
  tags: string[];
}

export function stopMessage(status: string | undefined, project: string): NotifyCopy {
  const name = project || 'your project';
  const byStatus: Record<string, NotifyCopy> = {
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
  return byStatus[status ?? ''] ?? byStatus.completed;
}

export function needsYouMessage(project: string): NotifyCopy {
  const name = project || 'your project';
  return {
    title: `Got a second? ${name} needs you`,
    message:
      'Cursor looks stuck waiting for your approval on a command. Open the IDE and tap Allow when you can.',
    priority: 'urgent',
    tags: ['wave', 'hourglass'],
  };
}

export function testMessage(project: string): NotifyCopy {
  const name = project || 'your project';
  return {
    title: `Hey - CursorPing is live`,
    message: `Pairing works for ${name}. You'll get a friendly ping here when the agent finishes or needs you.`,
    priority: 'default',
    tags: ['blush', 'bell'],
  };
}
