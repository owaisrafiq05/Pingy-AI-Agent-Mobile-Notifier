import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  getPendingMaxAgeMs,
  getPendingTimeoutMs,
  getServerUrl,
  getWatcherIntervalMs,
  getWorkspaceRoot,
  globalPendingStatePath,
  pendingStatePath,
  readActiveConfig,
} from './config';
import { showPairingQr } from './pairing';
import { runSetupWizard } from './setupWizard';
import { StatusBar } from './statusBar';
import { permissionMessage, testMessage } from './messages';
import {
  applyDecision,
  decidePending,
  hasNotifiedPending,
  parsePendingState,
} from './pendingState';
import { TerminalActivityTracker } from './terminalActivity';

let statusBar: StatusBar | undefined;
let watcherTimer: ReturnType<typeof setInterval> | undefined;
let terminalActivity: TerminalActivityTracker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorping.setup', async () => {
      try {
        const topic = await runSetupWizard(context);
        statusBar?.setReady(topic);
        const showQr = await vscode.window.showInformationMessage(
          `Pingy is set up for all projects. Subscribe to "${topic}" in the ntfy app (once).`,
          'Show Pairing'
        );
        if (showQr === 'Show Pairing') {
          await showPairingQr();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusBar?.setError(msg);
        vscode.window.showErrorMessage(`Pingy setup failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorping.sendTest', async () => {
      let config = readActiveConfig(getWorkspaceRoot());
      if (!config?.ntfyTopic) {
        const choice = await vscode.window.showWarningMessage(
          'Pingy is not set up yet. Setup once — it covers every project.',
          'Run Setup'
        );
        if (choice === 'Run Setup') {
          await vscode.commands.executeCommand('cursorping.setup');
          config = readActiveConfig(getWorkspaceRoot());
        }
        if (!config?.ntfyTopic) {
          return;
        }
      }
      const project = getWorkspaceRoot()
        ? path.basename(getWorkspaceRoot()!)
        : 'your projects';
      try {
        await sendNtfy(
          config.ntfyTopic,
          testMessage(project),
          config.serverUrl || getServerUrl()
        );
        vscode.window.showInformationMessage('Pingy: test notification sent.');
      } catch (e) {
        vscode.window.showErrorMessage(`Pingy: test failed: ${e}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorping.showPairingQr', async () => {
      await showPairingQr();
    })
  );

  try {
    statusBar = new StatusBar();
    context.subscriptions.push(statusBar);

    const cfg = readActiveConfig(getWorkspaceRoot());
    if (cfg?.ntfyTopic) {
      statusBar.setReady(cfg.ntfyTopic);
    }

    terminalActivity = new TerminalActivityTracker();
    context.subscriptions.push(terminalActivity);

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
      `Pingy activated with limited UI: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export function deactivate(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = undefined;
  }
  terminalActivity?.dispose();
  terminalActivity = undefined;
}

function startPendingWatcher(context: vscode.ExtensionContext): void {
  const interval = getWatcherIntervalMs();
  watcherTimer = setInterval(() => {
    void checkStalePending(context);
  }, interval);
}

/**
 * Polls the gate state written by the hooks. A gate that has stayed open past
 * the timeout without any follow-up event means the agent loop is blocked on
 * an approval prompt.
 */
async function checkStalePending(context: vscode.ExtensionContext): Promise<void> {
  const config = readActiveConfig(getWorkspaceRoot());
  if (!config?.ntfyTopic) {
    return;
  }

  const candidates = [globalPendingStatePath()];
  const root = getWorkspaceRoot();
  if (root) {
    candidates.push(pendingStatePath(root));
  }

  const options = {
    now: Date.now(),
    timeoutMs: config.pendingTimeoutMs ?? getPendingTimeoutMs(),
    maxAgeMs: getPendingMaxAgeMs(),
    isExecuting: terminalActivity?.isExecuting,
  };

  let anyWaiting = false;

  for (const stateFile of candidates) {
    if (!fs.existsSync(stateFile)) {
      continue;
    }

    let state;
    try {
      state = parsePendingState(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      continue;
    }

    const decision = decidePending(state, options);

    // Claim before sending so a detached hook timer cannot double-push.
    const claimed: string[] = [];
    let claimState = state;
    try {
      claimState = parsePendingState(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      /* use snapshot */
    }
    const { changed: claimedWrite } = applyDecision(
      claimState,
      { notify: decision.notify, expired: decision.expired },
      decision.observedTs
    );
    for (const id of decision.notify) {
      if (claimState[id]?.notified) {
        claimed.push(id);
      }
    }
    if (claimedWrite) {
      try {
        fs.writeFileSync(stateFile, JSON.stringify(claimState, null, 2), 'utf8');
      } catch (e) {
        console.error('pingy watcher: failed to claim pending', e);
      }
    }

    for (const id of claimed) {
      try {
        const entry = claimState[id] ?? state[id];
        const projectName =
          entry?.project || (root ? path.basename(root) : 'your project');
        await sendNtfy(
          config.ntfyTopic,
          permissionMessage(projectName),
          config.serverUrl || getServerUrl()
        );
        await context.globalState.update('cursorping.lastStatus', 'needs_approval');
      } catch (e) {
        // Un-claim so the next poll (or hook timer) can retry.
        try {
          const retry = parsePendingState(fs.readFileSync(stateFile, 'utf8'));
          if (retry[id] && retry[id].ts === decision.observedTs[id]) {
            retry[id].notified = false;
            fs.writeFileSync(stateFile, JSON.stringify(retry, null, 2), 'utf8');
          }
        } catch {
          /* best effort */
        }
        console.error('pingy watcher: notify failed', e);
      }
    }

    let fresh = state;
    try {
      fresh = parsePendingState(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      /* fall back to the snapshot we already have */
    }

    const { changed } = applyDecision(
      fresh,
      { notify: [], expired: decision.expired },
      decision.observedTs
    );

    if (changed) {
      try {
        fs.writeFileSync(stateFile, JSON.stringify(fresh, null, 2), 'utf8');
      } catch (e) {
        console.error('cursorping watcher: failed to write state', e);
      }
    }

    if (hasNotifiedPending(fresh)) {
      anyWaiting = true;
    }
  }

  if (anyWaiting) {
    statusBar?.setNeedsYou();
  } else if (config.ntfyTopic) {
    statusBar?.setReady(config.ntfyTopic);
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
  const priorityMap: Record<string, number> = {
    min: 1,
    low: 2,
    default: 3,
    high: 4,
    max: 5,
    urgent: 5,
  };
  const priorityNum = priorityMap[opts.priority ?? 'default'] ?? 3;
  try {
    // JSON publish keeps emoji titles intact (HTTP Title headers are Latin-1 only).
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        title: opts.title,
        message: opts.message,
        priority: priorityNum,
        tags: opts.tags?.length ? opts.tags : undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ntfy responded ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
