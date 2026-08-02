import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CursorPingConfig {
  ntfyTopic: string;
  serverUrl: string;
  pendingTimeoutMs: number;
}

const DEFAULT_SERVER = 'https://ntfy.sh';
const DEFAULT_TIMEOUT = 15000;

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

export function getWatcherIntervalMs(): number {
  return (
    vscode.workspace.getConfiguration('cursorping').get<number>('watcherIntervalMs') ??
    5000
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
    };
  } catch {
    return undefined;
  }
}

export function subscribeUrl(serverUrl: string, topic: string): string {
  const base = serverUrl.replace(/\/$/, '');
  return `${base}/${topic}`;
}
