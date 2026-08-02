import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  configPath,
  getPendingTimeoutMs,
  getServerUrl,
  hooksDir,
  readWorkspaceConfig,
} from './config';

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      // Do not copy generated config or runtime state from the template tree
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

export async function runSetupWizard(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<string> {
  const templateRoot = path.join(context.extensionPath, 'hooks-template');
  if (!fs.existsSync(templateRoot)) {
    throw new Error(
      `Hook templates not found at ${templateRoot}. Reinstall the CursorPing extension.`
    );
  }

  const existing = readWorkspaceConfig(workspaceRoot);
  const topic =
    existing?.ntfyTopic || `cursorping-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const destHooks = hooksDir(workspaceRoot);
  fs.mkdirSync(destHooks, { recursive: true });
  fs.mkdirSync(path.join(destHooks, 'state'), { recursive: true });

  copyRecursive(templateRoot, destHooks);

  const serverUrl = getServerUrl();
  const pendingTimeoutMs = getPendingTimeoutMs();

  fs.writeFileSync(
    configPath(workspaceRoot),
    JSON.stringify({ ntfyTopic: topic, serverUrl, pendingTimeoutMs }, null, 2),
    'utf8'
  );

  const hooksJsonPath = path.join(workspaceRoot, '.cursor', 'hooks.json');
  const hooksConfig = {
    version: 1,
    hooks: {
      beforeShellExecution: [
        { command: 'node .cursor/hooks/cursorping.js beforeShellExecution' },
      ],
      afterFileEdit: [{ command: 'node .cursor/hooks/cursorping.js afterFileEdit' }],
      stop: [{ command: 'node .cursor/hooks/cursorping.js stop' }],
    },
  };
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), 'utf8');

  await context.globalState.update('cursorping.lastTopic', topic);
  await context.globalState.update('cursorping.lastWorkspace', workspaceRoot);

  return topic;
}
