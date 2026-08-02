import * as vscode from 'vscode';

export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'cursorping.showPairingQr';
    this.setIdle();
    this.item.show();
  }

  setIdle(): void {
    this.item.text = '$(bell) CursorPing';
    this.item.tooltip = 'CursorPing — click to show pairing QR';
  }

  setReady(topic: string): void {
    this.item.text = '$(bell) CursorPing';
    this.item.tooltip = `CursorPing ready · topic ${topic}`;
  }

  setNeedsYou(): void {
    this.item.text = '$(warning) CursorPing: needs you';
    this.item.tooltip = 'Agent may be waiting on approval';
  }

  setFinished(status: string): void {
    this.item.text = `$(check) CursorPing: ${status}`;
    this.item.tooltip = `Last agent status: ${status}`;
  }

  setError(message: string): void {
    this.item.text = '$(error) CursorPing';
    this.item.tooltip = message;
  }

  dispose(): void {
    this.item.dispose();
  }
}
