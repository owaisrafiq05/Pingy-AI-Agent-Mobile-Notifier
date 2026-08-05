import * as vscode from 'vscode';
import type { PendingEntry } from './pendingState';

/**
 * A shell gate that has been approved starts running in a terminal; one that
 * is still waiting on the user does not. VS Code's shell integration API
 * reports execution starts, which lets us tell "the agent is blocked on a
 * prompt" apart from "npm install is just slow".
 *
 * This is a best-effort corroboration only. Shell integration needs VS Code
 * 1.93+ and a supported shell, and Cursor's agent terminal may not report at
 * all — in which case nothing is tracked and detection falls back to the
 * timeout on its own.
 */
export class TerminalActivityTracker implements vscode.Disposable {
  private readonly running = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly supported: boolean;

  constructor() {
    const api = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: vscode.Event<{
        execution: { commandLine?: { value?: string } };
      }>;
      onDidEndTerminalShellExecution?: vscode.Event<{
        execution: { commandLine?: { value?: string } };
      }>;
    };

    this.supported =
      typeof api.onDidStartTerminalShellExecution === 'function' &&
      typeof api.onDidEndTerminalShellExecution === 'function';

    if (!this.supported) {
      return;
    }

    this.disposables.push(
      api.onDidStartTerminalShellExecution!((e) => {
        const key = normalize(e.execution?.commandLine?.value);
        if (key) {
          this.running.set(key, Date.now());
        }
      }),
      api.onDidEndTerminalShellExecution!((e) => {
        const key = normalize(e.execution?.commandLine?.value);
        if (key) {
          this.running.delete(key);
        }
      })
    );
  }

  get isSupported(): boolean {
    return this.supported;
  }

  /**
   * Only ever suppresses a notification, never triggers one, so a missing or
   * mismatched signal degrades to the plain timeout behaviour.
   */
  isExecuting = (entry: PendingEntry): boolean => {
    if (!this.supported) {
      return false;
    }
    const wanted = normalize(entry.command);
    if (!wanted) {
      return false;
    }

    for (const [key, startedAt] of this.running) {
      if (startedAt < entry.ts) {
        // Started before this gate opened, so it belongs to something else.
        continue;
      }
      if (key === wanted || key.includes(wanted) || wanted.includes(key)) {
        return true;
      }
    }
    return false;
  };

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.running.clear();
  }
}

function normalize(command: string | null | undefined): string {
  return String(command ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
