/** Human-friendly notification copy (mirrors hooks-template/lib/messages.js). */

export interface ChatContext {
  firstPrompt?: string | null;
  latestPrompt?: string | null;
}

export interface NotifyCopy {
  title: string;
  message: string;
  priority: string;
  tags: string[];
}

function formatContextBody(
  base: string,
  project: string,
  chat?: ChatContext | null
): string {
  const lines = [base, '', `Project: ${project || 'your project'}`];
  if (chat?.firstPrompt) {
    lines.push(`Started with: "${chat.firstPrompt}"`);
  }
  if (chat?.latestPrompt && chat.latestPrompt !== chat.firstPrompt) {
    lines.push(`Latest ask: "${chat.latestPrompt}"`);
  }
  if (!chat?.firstPrompt && !chat?.latestPrompt) {
    lines.push('(No chat prompt available for this run.)');
  }
  return lines.join('\n');
}

export function stopMessage(
  status: string | undefined,
  project: string,
  chat?: ChatContext | null
): NotifyCopy {
  const name = project || 'your project';
  const byStatus: Record<string, NotifyCopy> = {
    completed: {
      title: `All done on ${name}`,
      message: formatContextBody(
        'Your Cursor agent just finished. Swing back when you can and check the results.',
        name,
        chat
      ),
      priority: 'default',
      tags: ['white_check_mark', 'tada'],
    },
    error: {
      title: `Heads up - snag on ${name}`,
      message: formatContextBody(
        'The agent hit an error and stopped. A quick look in Cursor should tell you what went wrong.',
        name,
        chat
      ),
      priority: 'high',
      tags: ['x', 'rotating_light'],
    },
    aborted: {
      title: `Run stopped on ${name}`,
      message: formatContextBody(
        'That session ended early (you cancelled it, or something interrupted it). No rush.',
        name,
        chat
      ),
      priority: 'low',
      tags: ['no_entry_sign'],
    },
  };
  return byStatus[status ?? ''] ?? byStatus.completed;
}

export const PERMISSION_TITLE = 'Cursor needs your attention';
export const PERMISSION_BODY =
  'The Agent is waiting for your permission to continue.';

/**
 * Sent when the agent is blocked on an approval prompt. The wording is fixed
 * so the push is instantly recognisable and never confused with a completion.
 */
export function permissionMessage(): NotifyCopy {
  return {
    title: PERMISSION_TITLE,
    message: PERMISSION_BODY,
    priority: 'urgent',
    tags: ['hand', 'hourglass'],
  };
}

/** @deprecated Use permissionMessage — kept so older installs keep working. */
export function needsYouMessage(): NotifyCopy {
  return permissionMessage();
}

export function testMessage(project: string): NotifyCopy {
  const name = project || 'your project';
  return {
    title: `Hey - CursorPing is live`,
    message: `Pairing works for ${name}. You'll get a friendly ping here when the agent finishes or needs you — including which project and what you asked.`,
    priority: 'default',
    tags: ['blush', 'bell'],
  };
}
