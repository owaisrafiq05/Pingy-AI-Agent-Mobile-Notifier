/** Notification copy for Pingy (mirrors hooks-template/lib/messages.js). */

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
    lines.push(`Prompt: "${chat.firstPrompt}"`);
  }
  if (chat?.latestPrompt && chat.latestPrompt !== chat.firstPrompt) {
    lines.push(`Latest: "${chat.latestPrompt}"`);
  }
  if (!chat?.firstPrompt && !chat?.latestPrompt) {
    lines.push('Prompt: (not available for this run)');
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
  return byStatus[status ?? ''] ?? byStatus.completed;
}

/**
 * Sent when the agent is blocked on an approval prompt.
 */
export function permissionMessage(
  project?: string,
  chat?: ChatContext | null
): NotifyCopy {
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
export function needsYouMessage(
  project?: string,
  chat?: ChatContext | null
): NotifyCopy {
  return permissionMessage(project, chat);
}

export function testMessage(project: string): NotifyCopy {
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
