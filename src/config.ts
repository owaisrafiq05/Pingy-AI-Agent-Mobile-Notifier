import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CursorPingConfig {
  ntfyTopic: string;
  serverUrl: string;
  pendingTimeoutMs: number;
  waitingRepingMs?: number;
}

const DEFAULT_SERVER = 'https://ntfy.sh';
/** @deprecated Superseded by DEFAULT_WAITING_AFTER; still written to hook configs for older installs. */
const DEFAULT_TIMEOUT = 2000;
/** Longer than any ordinary auto-run tool call, far shorter than a human's patience. */
const DEFAULT_WAITING_AFTER = 45000;
/** One "your agent needs you" push covers a session for this long. */
const DEFAULT_WAITING_REPING = 5 * 60 * 1000;

export function getServerUrl(): string {
  return (
    vscode.workspace.getConfiguration('cursorping').get<string>('serverUrl') ||
    DEFAULT_SERVER
  ).replace(/\/$/, '');
}

export function getPendingTimeoutMs(): number {
  return (
    vscode.workspace.getConfiguration('cursorping').get<number>('pendingTimeoutMs') ??
    DEFAULT_TIMEOUT
  );
}

/**
 * How long a Cursor gate must stay open before it counts as an approval prompt.
 *
 * Cursor fires its gate events whether or not you are ever asked, so this is the
 * line between "waiting on you" and "auto-running something slow". The old
 * 2-second `pendingTimeoutMs` sat well below how long an ordinary auto-run tool
 * call takes, which is why waiting pushes arrived for commands nobody was asked
 * about. `pendingTimeoutMs` no longer drives this decision.
 */
export function getWaitingAfterMs(): number {
  return (
    vscode.workspace.getConfiguration('cursorping').get<number>('waitingAfterMs') ??
    DEFAULT_WAITING_AFTER
  );
}

/**
 * Claude Code fires one notification per blocking dialog, and an ordinary turn in
 * `default` permission mode opens many. The push means "come back to your
 * terminal", so repeats inside this window add nothing.
 */
export function getWaitingRepingMs(): number {
  return (
    vscode.workspace.getConfiguration('cursorping').get<number>('waitingRepingMs') ??
    DEFAULT_WAITING_REPING
  );
}

/**
 * Whether to alert on Cursor shell gates that terminal activity cannot vouch for.
 *
 * Off by default. Shell commands are the tool calls that legitimately run for
 * minutes, so without a terminal signal an open gate is far more likely to be an
 * auto-run in progress than a prompt waiting on you.
 */
export function getAllowUncorroboratedShell(): boolean {
  return (
    vscode.workspace
      .getConfiguration('cursorping')
      .get<boolean>('alertOnUnconfirmedShellWaits') ?? false
  );
}

/** Gates older than this are treated as abandoned rather than waiting. */
export function getPendingMaxAgeMs(): number {
  return (
    vscode.workspace.getConfiguration('cursorping').get<number>('pendingMaxAgeMs') ??
    30 * 60 * 1000
  );
}

export function getWatcherIntervalMs(): number {
  return (
    vscode.workspace.getConfiguration('cursorping').get<number>('watcherIntervalMs') ??
    1000
  );
}

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Cursor user config root: ~/.cursor (applies to every workspace). */
export function cursorUserDir(): string {
  return path.join(os.homedir(), '.cursor');
}

export function globalHooksDir(): string {
  return path.join(cursorUserDir(), 'hooks');
}

export function globalConfigPath(): string {
  return path.join(globalHooksDir(), 'cursorping.config.json');
}

export function globalPendingStatePath(): string {
  return path.join(globalHooksDir(), 'state', 'pending.json');
}

export function globalHooksJsonPath(): string {
  return path.join(cursorUserDir(), 'hooks.json');
}

/** Claude Code user config root: ~/.claude (applies to every project). */
export function claudeUserDir(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Hook scripts live in their own subdirectory so they never collide with other
 * tools' hooks under ~/.claude/hooks.
 */
export function claudeHooksDir(): string {
  return path.join(claudeUserDir(), 'hooks', 'pingy');
}

export function claudeConfigPath(): string {
  return path.join(claudeHooksDir(), 'cursorping.config.json');
}

/**
 * Unlike ~/.cursor/hooks.json this file holds real user settings (theme, update
 * channel, permissions), so it must be merged into, never overwritten.
 */
export function claudeSettingsPath(): string {
  return path.join(claudeUserDir(), 'settings.json');
}

export function readGlobalConfig(): CursorPingConfig | undefined {
  const file = globalConfigPath();
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ntfyTopic: raw.ntfyTopic ?? '',
      serverUrl: raw.serverUrl ?? getServerUrl(),
      pendingTimeoutMs: raw.pendingTimeoutMs ?? getPendingTimeoutMs(),
      waitingRepingMs: raw.waitingRepingMs ?? getWaitingRepingMs(),
    };
  } catch {
    return undefined;
  }
}

/** Prefer global (one-time) config; fall back to legacy per-project config. */
export function readActiveConfig(workspaceRoot?: string): CursorPingConfig | undefined {
  const global = readGlobalConfig();
  if (global?.ntfyTopic) {
    return global;
  }
  if (workspaceRoot) {
    return readWorkspaceConfig(workspaceRoot);
  }
  return undefined;
}

/** @deprecated Prefer readActiveConfig — kept for migration from older installs. */
export function hooksDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.cursor', 'hooks');
}

export function configPath(workspaceRoot: string): string {
  return path.join(hooksDir(workspaceRoot), 'cursorping.config.json');
}

export function pendingStatePath(workspaceRoot: string): string {
  return path.join(hooksDir(workspaceRoot), 'state', 'pending.json');
}

export function readWorkspaceConfig(workspaceRoot: string): CursorPingConfig | undefined {
  const file = configPath(workspaceRoot);
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ntfyTopic: raw.ntfyTopic ?? '',
      serverUrl: raw.serverUrl ?? getServerUrl(),
      pendingTimeoutMs: raw.pendingTimeoutMs ?? getPendingTimeoutMs(),
      waitingRepingMs: raw.waitingRepingMs ?? getWaitingRepingMs(),
    };
  } catch {
    return undefined;
  }
}

export function subscribeUrl(serverUrl: string, topic: string): string {
  const base = serverUrl.replace(/\/$/, '');
  return `${base}/${topic}`;
}
