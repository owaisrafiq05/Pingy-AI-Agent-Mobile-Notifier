import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  getPendingTimeoutMs,
  getServerUrl,
  globalConfigPath,
  globalHooksDir,
  globalHooksJsonPath,
  readGlobalConfig,
} from './config';

const CURSORPING_CMD = 'cursorping.js';

/**
 * Gate events (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`) open
 * a window where Cursor may ask the user to approve something; the rest close
 * it again. Subscribing to both sides is what makes "waiting for permission"
 * observable, since Cursor exposes no event for the prompt itself.
 */
export const CURSORPING_EVENTS = [
  'beforeSubmitPrompt',
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'afterMCPExecution',
  'afterFileEdit',
  'afterAgentResponse',
  'afterAgentThought',
  'subagentStop',
  'stop',
] as const;

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === 'cursorping.config.json' || entry === 'state') {
        continue;
      }
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function isCursorPingCommand(command: string | undefined): boolean {
  return typeof command === 'string' && command.includes(CURSORPING_CMD);
}

/**
 * Merge CursorPing hooks into ~/.cursor/hooks.json without wiping other user hooks.
 */
function mergeUserHooksJson(hooksJsonPath: string): void {
  const cursorPingHooks: Record<string, Array<{ command: string }>> = {};
  for (const event of CURSORPING_EVENTS) {
    cursorPingHooks[event] = [
      { command: `node ./hooks/cursorping.js ${event}` },
    ];
  }

  let existing: { version?: number; hooks?: Record<string, Array<{ command?: string }>> } =
    { version: 1, hooks: {} };

  if (fs.existsSync(hooksJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      if (!existing.hooks || typeof existing.hooks !== 'object') {
        existing.hooks = {};
      }
    } catch {
      const backup = `${hooksJsonPath}.bak-${Date.now()}`;
      fs.copyFileSync(hooksJsonPath, backup);
      existing = { version: 1, hooks: {} };
    }
  }

  const hooks = { ...existing.hooks };

  for (const [eventName, entries] of Object.entries(cursorPingHooks)) {
    const prior = Array.isArray(hooks[eventName]) ? hooks[eventName]! : [];
    const kept = prior.filter((h) => !isCursorPingCommand(h.command));
    hooks[eventName] = [...kept, ...entries];
  }

  const next = {
    version: existing.version ?? 1,
    hooks,
  };
  fs.writeFileSync(hooksJsonPath, JSON.stringify(next, null, 2), 'utf8');
}

/**
 * One-time global setup: installs hooks under ~/.cursor so every project notifies.
 */
export async function runSetupWizard(context: vscode.ExtensionContext): Promise<string> {
  const templateRoot = path.join(context.extensionPath, 'hooks-template');
  if (!fs.existsSync(templateRoot)) {
    throw new Error(
      `Hook templates not found at ${templateRoot}. Reinstall the Pingy extension.`
    );
  }

  const existing = readGlobalConfig();
  const topic =
    existing?.ntfyTopic || `pingy-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const destHooks = globalHooksDir();
  fs.mkdirSync(destHooks, { recursive: true });
  fs.mkdirSync(path.join(destHooks, 'state'), { recursive: true });

  copyRecursive(templateRoot, destHooks);

  const serverUrl = getServerUrl();
  const pendingTimeoutMs = getPendingTimeoutMs();

  fs.writeFileSync(
    globalConfigPath(),
    JSON.stringify({ ntfyTopic: topic, serverUrl, pendingTimeoutMs }, null, 2),
    'utf8'
  );

  mergeUserHooksJson(globalHooksJsonPath());

  await context.globalState.update('cursorping.lastTopic', topic);
  await context.globalState.update('cursorping.setupMode', 'global');

  return topic;
}
