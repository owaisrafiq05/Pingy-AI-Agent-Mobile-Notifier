/**
 * Decides when an open approval gate has stalled long enough to count as
 * "the agent is waiting for the user".
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
}

export type PendingState = Record<string, PendingEntry>;

export interface DecisionOptions {
  now: number;
  timeoutMs: number;
  maxAgeMs: number;
  /**
   * Corroborating signal: the gate's command is demonstrably executing right
   * now, so the agent is busy rather than blocked on a prompt.
   */
  isExecuting?: (entry: PendingEntry) => boolean;
  /**
   * When true, shell gates may notify only if isExecuting says the command is
   * not running. When false/omitted, shell gates stay silent — without terminal
   * activity we cannot tell a slow auto-run apart from a real Run/Skip wait.
   */
  shellActivityAvailable?: boolean;
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

    // Still inside the window where a normal fast tool call would have
    // resolved on its own.
    if (age < opts.timeoutMs) {
      continue;
    }

    if (isShellGate(entry)) {
      // Prefer missing a wait over pinging while a command is just running.
      if (!opts.shellActivityAvailable) {
        continue;
      }
      if (opts.isExecuting?.(entry)) {
        continue;
      }
    } else if (opts.isExecuting?.(entry)) {
      continue;
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
