import { sleep } from "#compiled/@workflow/core/index.js";

// Read by the session workflow body, so this module must not import Node.js
// built-ins.

/**
 * The timers of one foreground wait: one durable sleep per timed call, such
 * as a `task_wait` timeout. A timer still pending when the wait ends is
 * abandoned: it no longer affects the turn, though its durable sleep may
 * still wake the run once when it elapses.
 */
export class WaitTimers {
  readonly #armed = new Map<string, Promise<string>>();

  constructor(timeouts: readonly { readonly callId: string; readonly timeoutMs: number }[] = []) {
    for (const { callId, timeoutMs } of timeouts) this.arm(callId, timeoutMs);
  }

  /** Starts a timer for one call, replacing any timer it already had. */
  arm(callId: string, ms: number): void {
    this.#armed.set(
      callId,
      sleep(ms).then(() => callId),
    );
  }

  /** Resolves with the call ID of the next timer to fire, or is `undefined` when none is armed. */
  next(): Promise<string> | undefined {
    return this.#armed.size === 0 ? undefined : Promise.race(this.#armed.values());
  }

  /** Stops racing the timers of calls that resolved or no longer wait. */
  disarm(callIds: Iterable<string>): void {
    for (const callId of callIds) this.#armed.delete(callId);
  }
}
