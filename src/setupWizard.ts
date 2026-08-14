import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  claudeConfigPath,
  claudeHooksDir,
  claudeSettingsPath,
  getPendingTimeoutMs,
  getServerUrl,
  getWaitingRepingMs,
  globalConfigPath,
  globalHooksDir,
  globalHooksJsonPath,
  readGlobalConfig,
} from './config';

const CURSORPING_CMD = 'cursorping.js';
const CLAUDE_CMD = 'pingy-claude.js';

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
 * Claude Code hook events Pingy subscribes to, with the matcher each one needs.
 *
 * Far shorter than CURSORPING_EVENTS because Claude Code has a real
 * `Notification` event for "the agent is blocked on you" — none of Cursor's
 * gate-open/gate-close bookkeeping and timeout heuristics are required.
 */
export const CLAUDE_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'UserPromptSubmit' },
  // On `Notification` the matcher is tested against `notification_type`, so this
  // list is exactly the set of dialogs that block the agent on the user. The
  // hook filters again on its own — a build that omits `notification_type`
  // bypasses matchers entirely and would otherwise push for auth notices too.
  {
    event: 'Notification',
    matcher: [
      'permission_prompt',
      'worker_permission_prompt',
      'agent_needs_input',
      'idle_prompt',
      'elicitation_dialog',
      'elicitation_url_dialog',
    ].join('|'),
  },
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SessionEnd' },
];

interface ClaudeHookHandler {
  type?: string;
  command?: string;
  timeout?: number;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks?: ClaudeHookHandler[];
}

function isClaudeCommand(command: string | undefined): boolean {
  return typeof command === 'string' && command.includes(CLAUDE_CMD);
}

/**
 * Merge Pingy's hooks into ~/.claude/settings.json.
 *
 * Two things differ from the Cursor merge: the schema is nested
 * (`Event: [{ matcher?, hooks: [{ type, command }] }]`), and this file holds
 * unrelated user settings that must survive untouched.
 */
function mergeClaudeSettings(settingsPath: string, scriptPath: string): void {
  let existing: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      existing = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      const backup = `${settingsPath}.bak-${Date.now()}`;
      fs.copyFileSync(settingsPath, backup);
      existing = {};
    }
  }

  const priorHooks = existing.hooks;
  const hooks: Record<string, ClaudeHookGroup[]> =
    priorHooks && typeof priorHooks === 'object'
      ? { ...(priorHooks as Record<string, ClaudeHookGroup[]>) }
      : {};

  for (const { event, matcher } of CLAUDE_EVENTS) {
    const prior = Array.isArray(hooks[event]) ? hooks[event] : [];

    // Strip our handlers from any prior group, then drop groups left empty, so
    // re-running setup never stacks duplicates and never eats someone else's hook.
    const kept = prior
      .map((group) => ({
        ...group,
        hooks: (group?.hooks ?? []).filter((h) => !isClaudeCommand(h?.command)),
      }))
      .filter((group) => group.hooks.length > 0);

    const handler: ClaudeHookHandler = {
      type: 'command',
      command: `node "${scriptPath}" ${event}`,
      // The ntfy POST self-aborts at 5s; this is the outer backstop.
      timeout: 10,
    };
    const group: ClaudeHookGroup = matcher
      ? { matcher, hooks: [handler] }
      : { hooks: [handler] };

    hooks[event] = [...kept, group];
  }

  const next = { ...existing, hooks };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8');
}

/**
 * Install the Claude Code hooks under ~/.claude.
 *
 * Takes the topic from the Cursor setup so both agents publish to the same ntfy
 * topic — one QR, one subscription, and existing users need no re-pairing.
 */
export async function runClaudeSetup(
  context: vscode.ExtensionContext,
  topic: string
): Promise<void> {
  const templateRoot = path.join(context.extensionPath, 'hooks-template');
  if (!fs.existsSync(templateRoot)) {
    throw new Error(
      `Hook templates not found at ${templateRoot}. Reinstall the Pingy extension.`
    );
  }

  const destHooks = claudeHooksDir();
  fs.mkdirSync(destHooks, { recursive: true });
  fs.mkdirSync(path.join(destHooks, 'state'), { recursive: true });

  copyRecursive(templateRoot, destHooks);

  fs.writeFileSync(
    claudeConfigPath(),
    JSON.stringify(
      {
        ntfyTopic: topic,
        serverUrl: getServerUrl(),
        pendingTimeoutMs: getPendingTimeoutMs(),
        waitingRepingMs: getWaitingRepingMs(),
      },
      null,
      2
    ),
    'utf8'
  );

  // Claude Code resolves hook commands with cwd at the project directory, not
  // ~/.claude, so the path must be absolute. Forward slashes work on every
  // platform and avoid backslash escaping; the quotes matter because home
  // directories routinely contain spaces.
  const scriptPath = path.join(destHooks, CLAUDE_CMD).replace(/\\/g, '/');
  mergeClaudeSettings(claudeSettingsPath(), scriptPath);
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
