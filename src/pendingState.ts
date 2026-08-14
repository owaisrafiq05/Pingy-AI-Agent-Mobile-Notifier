/**
 * Decides when an open approval gate has stalled long enough to count as
 * "the agent is waiting for the user".
 *
 * Cursor exposes no event for "approval dialog opened" — only the gate events
 * that fire *before* a tool runs, whether or not the user is ever asked. So a
 * gate that stays open means one of two things:
 *
 *   1. Cursor is showing a Run/Skip prompt        → worth a push
 *   2. Cursor auto-ran the tool and it is slow    → must stay silent
 *
 * Nothing in the payload distinguishes them, which is why the old "2 seconds and
 * no follow-up event" rule pushed "your agent needs you" every time an auto-run
 * command took a moment. The rules below only notify when the evidence positively
 * favours case 1: the gate is one Cursor actually prompts for, it has been open
 * far longer than a tool call takes, and either terminal activity proves nothing
 * is running or the user is not sitting at the window.
 *
 * Kept free of vscode and fs imports so the rules can be unit tested directly.
 */

export interface PendingEntry {
  ts: number;
  notified?: boolean;
  event?: string | null;
  toolName?: string | null;
  command?: string | null;
  toolUseId?: string | null;
  project?: string | null;
  /**
   * Recorded by the hook: does Cursor ever ask the user about this kind of gate?
   * Absent on entries written by older installs, hence the fallback below.
   */
  promptable?: boolean;
}

export type PendingState = Record<string, PendingEntry>;

export interface DecisionOptions {
  now: number;
  /**
   * How long a gate must stay open before it can count as an approval prompt.
   * A real prompt waits for a human, so this can be generous; every millisecond
   * below the slowest auto-run tool call is a false "waiting" push.
   */
  waitingAfterMs: number;
  maxAgeMs: number;
  /**
   * Corroborating signal: the gate's command is demonstrably executing right
   * now, so the agent is busy rather than blocked on a prompt.
   */
  isExecuting?: (entry: PendingEntry) => boolean;
  /**
   * True only when shell integration has proven it reports executions in this
   * window — the API merely existing tells us nothing, and trusting its silence
   * turned every slow auto-run command into a false alert.
   */
  shellActivityAvailable?: boolean;
  /**
   * True when a human is demonstrably at the Cursor window right now. Someone
   * watching the agent work does not need their phone buzzed, and if a prompt
   * really is open they are looking straight at it.
   */
  userPresent?: boolean;
  /**
   * Opt in to alerting on shell gates that terminal activity cannot vouch for.
   *
   * Off by default: shell commands are the tools that legitimately run for
   * minutes (installs, builds, test suites), so without a terminal signal an
   * open gate is far more likely to be a slow auto-run than a prompt. Users who
   * never use auto-run can turn this on and accept the occasional false alert.
   */
  allowUncorroboratedShell?: boolean;
}

export interface PendingDecision {
  notify: string[];
  expired: string[];
  /**
   * Timestamps as they looked when the decision was made, so the result can be
   * written back safely even though hooks may have rewritten the file in the
   * meantime.
   */
  observedTs: Record<string, number>;
}

/** Tolerant parse — a hook may be mid-write, and a bad file must not throw. */
export function parsePendingState(raw: string): PendingState {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {};
    }
    return data as PendingState;
  } catch {
    return {};
  }
}

/** Shell gates need terminal-activity corroboration; timeout alone is too noisy. */
export function isShellGate(entry: PendingEntry): boolean {
  return entry.event === 'beforeShellExecution' || entry.toolName === 'Shell';
}

/**
 * The gates Cursor can actually stop and ask about: running a shell command and
 * calling an MCP tool.
 *
 * `preToolUse` fires for every tool the agent uses — reads, searches, edits —
 * and Cursor applies those itself. Treating one as a possible prompt meant any
 * slow read or search became a "waiting" push, and the shell and MCP calls that
 * *are* promptable arrive on their own events anyway.
 */
export function isPromptableGate(entry: PendingEntry): boolean {
  if (typeof entry.promptable === 'boolean') {
    return entry.promptable;
  }
  // Written by an install that predates the flag.
  if (entry.event) {
    return entry.event === 'beforeShellExecution' || entry.event === 'beforeMCPExecution';
  }
  return entry.toolName === 'Shell' || entry.toolName === 'MCP';
}

export function decidePending(
  state: PendingState,
  opts: DecisionOptions
): PendingDecision {
  const notify: string[] = [];
  const expired: string[] = [];
  const observedTs: Record<string, number> = {};

  for (const [id, entry] of Object.entries(state)) {
    if (!entry || typeof entry.ts !== 'number') {
      expired.push(id);
      continue;
    }

    observedTs[id] = entry.ts;
    const age = opts.now - entry.ts;

    // Cursor restarted or the agent died without ever resolving the gate.
    if (age > opts.maxAgeMs) {
      expired.push(id);
      continue;
    }

    if (entry.notified) {
      continue;
    }

    // Cursor never asks about this gate, so an open one only means "busy".
    if (!isPromptableGate(entry)) {
      continue;
    }

    // Still inside the window where an auto-run tool call would have finished
    // on its own.
    if (age < opts.waitingAfterMs) {
      continue;
    }

    // The command is running, so the agent is working, not blocked.
    if (opts.isExecuting?.(entry)) {
      continue;
    }

    // Terminal activity can only corroborate shell gates, and only where shell
    // integration actually reports.
    const corroborated = isShellGate(entry) && opts.shellActivityAvailable === true;
    if (!corroborated) {
      // A shell command with no terminal signal is indistinguishable from a slow
      // auto-run, and those are the tool calls that legitimately take minutes.
      if (isShellGate(entry) && opts.allowUncorroboratedShell !== true) {
        continue;
      }
      // Otherwise age is all we have, so at least require that nobody is sitting
      // in front of the window we would be telling them to come back to.
      if (opts.userPresent === true) {
        continue;
      }
    }

    notify.push(id);
  }

  return { notify, expired, observedTs };
}

/**
 * Apply a decision to a state object. Notified gates keep their entry so the
 * prompt stays deduped until a hook clears it on approve/reject.
 *
 * `observedTs` guards against clobbering a hook that wrote to the file while a
 * notification was in flight: an entry whose timestamp moved is a different
 * permission request and must keep its fresh, un-notified state.
 */
export function applyDecision(
  state: PendingState,
  actions: { notify: string[]; expired: string[] },
  observedTs: Record<string, number> = {}
): { state: PendingState; changed: boolean } {
  let changed = false;

  const isStillTheSameGate = (id: string): boolean => {
    const expected = observedTs[id];
    if (typeof expected !== 'number') {
      return true;
    }
    return state[id]?.ts === expected;
  };

  for (const id of actions.expired) {
    if (id in state && isStillTheSameGate(id)) {
      delete state[id];
      changed = true;
    }
  }

  for (const id of actions.notify) {
    const entry = state[id];
    if (entry && !entry.notified && isStillTheSameGate(id)) {
      entry.notified = true;
      changed = true;
    }
  }

  return { state, changed };
}

/** True when any gate is currently open and already announced. */
export function hasNotifiedPending(state: PendingState): boolean {
  return Object.values(state).some((entry) => entry?.notified === true);
}
