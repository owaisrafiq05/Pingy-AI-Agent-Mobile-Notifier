import * as vscode from 'vscode';
import { getServerUrl, readWorkspaceConfig, subscribeUrl } from './config';

export async function showPairingQr(
  workspaceRoot: string | undefined
): Promise<void> {
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('CursorPing: open a workspace folder first.');
    return;
  }

  const config = readWorkspaceConfig(workspaceRoot);
  if (!config?.ntfyTopic) {
    const choice = await vscode.window.showWarningMessage(
      'CursorPing is not set up in this workspace yet.',
      'Run Setup'
    );
    if (choice === 'Run Setup') {
      await vscode.commands.executeCommand('cursorping.setup');
    }
    return;
  }

  const serverUrl = config.serverUrl || getServerUrl();
  const url = subscribeUrl(serverUrl, config.ntfyTopic);

  let dataUrl: string | undefined;
  let qrError: string | undefined;
  try {
    // CommonJS require — reliable in the VS Code/Cursor extension host
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = require('qrcode') as typeof import('qrcode');
    dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 });
  } catch (e) {
    qrError = e instanceof Error ? e.message : String(e);
    console.error('cursorping: QR generation failed', e);
  }

  const panel = vscode.window.createWebviewPanel(
    'cursorpingPairing',
    'CursorPing Pairing',
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );

  const qrBlock = dataUrl
    ? `<img src="${dataUrl}" alt="ntfy subscribe QR code" width="280" height="280" />`
    : `<p class="warn">QR image unavailable${qrError ? ` (${escapeHtml(qrError)})` : ''}. Subscribe manually with the topic below.</p>`;

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CursorPing Pairing</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
      text-align: center;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 8px; }
    p { opacity: 0.85; max-width: 420px; margin: 0 auto 16px; line-height: 1.4; }
    img { background: #fff; padding: 12px; border-radius: 8px; }
    code {
      display: inline-block;
      margin-top: 16px;
      padding: 8px 12px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      word-break: break-all;
      font-size: 0.9rem;
    }
    .hint { margin-top: 20px; font-size: 0.85rem; opacity: 0.7; }
    .warn { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h1>CursorPing</h1>
  <p>Scan this QR with the ntfy app (or subscribe to the topic below) to receive agent notifications.</p>
  ${qrBlock}
  <div><code>${escapeHtml(config.ntfyTopic)}</code></div>
  <p class="hint">${escapeHtml(url)}</p>
</body>
</html>`;

  // Also offer clipboard shortcuts
  const pick = await vscode.window.showInformationMessage(
    `CursorPing topic: ${config.ntfyTopic}`,
    'Copy Topic',
    'Copy URL'
  );
  if (pick === 'Copy Topic') {
    await vscode.env.clipboard.writeText(config.ntfyTopic);
  } else if (pick === 'Copy URL') {
    await vscode.env.clipboard.writeText(url);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
