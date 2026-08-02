import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  getPendingTimeoutMs,
  getServerUrl,
  getWatcherIntervalMs,
  getWorkspaceRoot,
  pendingStatePath,
  readWorkspaceConfig,
} from './config';
import { showPairingQr } from './pairing';
import { runSetupWizard } from './setupWizard';
import { StatusBar } from './statusBar';
import { needsYouMessage, testMessage } from './messages';

let statusBar: StatusBar | undefined;
let watcherTimer: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Register commands first so palette entries always resolve even if later init fails
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorping.setup', async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('CursorPing: open a workspace folder first.');
        return;
      }
      try {
        const topic = await runSetupWizard(context, workspaceRoot);
        statusBar?.setReady(topic);
        const showQr = await vscode.window.showInformationMessage(
          `CursorPing set up. Subscribe to topic "${topic}" in the ntfy app.`,
          'Show QR Code'
        );
        if (showQr === 'Show QR Code') {
          await showPairingQr(workspaceRoot);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusBar?.setError(msg);
        vscode.window.showErrorMessage(`CursorPing setup failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorping.sendTest', async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('CursorPing: open a workspace folder first.');
        return;
      }
      let config = readWorkspaceConfig(workspaceRoot);
      if (!config?.ntfyTopic) {
        const choice = await vscode.window.showWarningMessage(
          'CursorPing is not set up yet.',
          'Run Setup'
        );
        if (choice === 'Run Setup') {
          await vscode.commands.executeCommand('cursorping.setup');
          config = readWorkspaceConfig(workspaceRoot);
        }
        if (!config?.ntfyTopic) {
          return;
        }
      }
      const project = path.basename(workspaceRoot);
      try {
        await sendNtfy(
          config.ntfyTopic,
          testMessage(project),
          config.serverUrl || getServerUrl()
        );
        vscode.window.showInformationMessage('CursorPing: test notification sent.');
      } catch (e) {
        vscode.window.showErrorMessage(`CursorPing: test failed: ${e}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorping.showPairingQr', async () => {
      await showPairingQr(getWorkspaceRoot());
    })
  );

  try {
    statusBar = new StatusBar();
    context.subscriptions.push(statusBar);

    const root = getWorkspaceRoot();
    if (root) {
      const cfg = readWorkspaceConfig(root);
      if (cfg?.ntfyTopic) {
        statusBar.setReady(cfg.ntfyTopic);
      }
    }

    startPendingWatcher(context);
    context.subscriptions.push({
      dispose: () => {
        if (watcherTimer) {
          clearInterval(watcherTimer);
          watcherTimer = undefined;
        }
      },
    });
  } catch (e) {
    console.error('cursorping: partial activation', e);
    void vscode.window.showWarningMessage(
      `CursorPing activated with limited UI: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export function deactivate(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = undefined;
  }
}

/** Option B: extension-side interval polls the same pending.json state file. */
function startPendingWatcher(context: vscode.ExtensionContext): void {
  const interval = getWatcherIntervalMs();
  watcherTimer = setInterval(() => {
    void checkStalePending(context);
  }, interval);
}

async function checkStalePending(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }

  const config = readWorkspaceConfig(workspaceRoot);
  if (!config?.ntfyTopic) {
    return;
  }

  const stateFile = pendingStatePath(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  let state: Record<string, { ts?: number; notified?: boolean }>;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return;
  }

  const timeout = config.pendingTimeoutMs ?? getPendingTimeoutMs();
  const now = Date.now();
  const project = path.basename(workspaceRoot);
  let changed = false;

  for (const [id, entry] of Object.entries(state)) {
    if (!entry || typeof entry.ts !== 'number' || entry.notified) {
      continue;
    }
    if (now - entry.ts < timeout) {
      continue;
    }

    try {
      await sendNtfy(
        config.ntfyTopic,
        needsYouMessage(project),
        config.serverUrl || getServerUrl()
      );
      statusBar?.setNeedsYou();
      delete state[id];
      changed = true;
      await context.globalState.update('cursorping.lastStatus', 'needs_approval');
    } catch (e) {
      console.error('cursorping watcher: notify failed', e);
    }
  }

  if (changed) {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      console.error('cursorping watcher: failed to write state', e);
    }
  }
}

async function sendNtfy(
  topic: string,
  opts: { title: string; message: string; priority?: string; tags?: string[] },
  serverUrl: string
): Promise<void> {
  const base = serverUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const toHeader = (v: string) =>
    v.replace(/[\u2013\u2014\u2015]/g, '-').replace(/[^\x20-\x7E]/g, '');
  try {
    const headers: Record<string, string> = {
      Title: toHeader(opts.title),
      Priority: opts.priority ?? 'default',
    };
    if (opts.tags?.length) {
      headers.Tags = opts.tags.join(',');
    }
    const res = await fetch(`${base}/${topic}`, {
      method: 'POST',
      headers,
      body: opts.message,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ntfy responded ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
