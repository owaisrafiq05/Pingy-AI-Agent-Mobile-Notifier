import * as vscode from 'vscode';

/**
 * Is there a human at the Cursor window right now?
 *
 * Cursor gives no way to see its approval prompt, so when a gate stays open we
 * cannot tell "waiting on you" from "auto-running something slow". Presence
 * breaks the tie in the direction that matters: if someone is at the keyboard,
 * a phone push is either wrong (nothing is being asked) or pointless (the prompt
 * is on the screen in front of them).
 *
 * Only signals a human can produce count. Document changes are deliberately not
 * tracked — the agent edits files constantly, and treating that as presence
 * would suppress the alerts this extension exists to send. Selection changes are
 * filtered to mouse and keyboard for the same reason: applying an agent edit
 * moves the cursor with kind `Command`.
 */
export class UserPresenceTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private lastInteractionAt = 0;

  constructor() {
    if (vscode.window.state?.focused) {
      this.lastInteractionAt = Date.now();
    }

    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        // Coming back to the window is itself an interaction; leaving it is not.
        if (state.focused) {
          this.touch();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const kind = e.kind;
        if (
          kind === vscode.TextEditorSelectionChangeKind.Mouse ||
          kind === vscode.TextEditorSelectionChangeKind.Keyboard
        ) {
          this.touch();
        }
      })
    );
  }

  private touch(): void {
    this.lastInteractionAt = Date.now();
  }

  /** Milliseconds since the last human signal, or Infinity if there never was one. */
  idleFor(now = Date.now()): number {
    return this.lastInteractionAt ? now - this.lastInteractionAt : Infinity;
  }

  /**
   * True only with positive evidence of a person: the window has focus *and*
   * they touched it inside `idleMs`. A window left focused while its owner walked
   * away goes idle and stops suppressing — that case is the whole point of the
   * extension.
   */
  isPresent = (idleMs: number, now = Date.now()): boolean => {
    if (!vscode.window.state?.focused) {
      return false;
    }
    return this.idleFor(now) < idleMs;
  };

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
