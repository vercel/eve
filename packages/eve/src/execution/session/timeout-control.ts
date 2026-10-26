import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  cancelSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session/timeout-steps.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

/**
 * Workflow-body handle for one owner's idle timeout. Activity moves the
 * deadline only in memory; when the durable timer fires before the session
 * has been idle for the whole window, the owner re-arms it for the new
 * deadline. An active session therefore costs one timer per window, not one
 * per turn.
 */
export interface SessionTimeoutControl {
  /** Current idle deadline, including activity since the durable timer was armed. */
  getDeadline(): Date;
  dispose(): Promise<void>;
  /**
   * Answers this owner's elapsed timer: `expired` once the session has been
   * idle for the whole window, otherwise `extended` after arming a timer for
   * the deadline that the latest activity set.
   */
  handleTimerElapsed(): Promise<"expired" | "extended">;
  /** Restarts the idle window from now. */
  recordActivity(): void;
  start(): Promise<void>;
}

/** Creates the idle timeout for one owner run, or `undefined` when timeouts are disabled. */
export function createSessionTimeoutControl(input: {
  /** Preserve the idle window when proactively moving an existing session. */
  readonly deadline?: Date;
  readonly sessionId: string;
  readonly timeoutMs: number | false;
}): SessionTimeoutControl | undefined {
  const { sessionId, timeoutMs } = input;
  if (timeoutMs === false) return undefined;
  // Workflow's clock is replay-stable. An owner boots right after activity:
  // the session's creation, the delivery a successor runs, or the turn that
  // compacted before a successor took over.
  let lastActivityAt =
    input.deadline === undefined ? Date.now() : input.deadline.getTime() - timeoutMs;
  let active: { readonly runId: string } | undefined;
  let startup: Promise<void> | undefined;

  const arm = async (): Promise<void> => {
    startup ??= (async () => {
      active = await startSessionTimeoutStep({
        deadline: new Date(lastActivityAt + timeoutMs),
        ownerRunId: getWorkflowMetadata().workflowRunId,
        token: sessionCommandHookToken(sessionId),
      });
    })();
    await startup;
  };

  return {
    getDeadline(): Date {
      return new Date(lastActivityAt + timeoutMs);
    },

    async dispose(): Promise<void> {
      try {
        await startup;
      } catch {
        // A failed startup has no child run to cancel.
      }
      if (active === undefined) return;
      const current = active;
      active = undefined;
      await cancelSessionTimeoutStep({ runId: current.runId });
    },

    async handleTimerElapsed(): Promise<"expired" | "extended"> {
      if (Date.now() >= lastActivityAt + timeoutMs) return "expired";
      // The timer that fired has already ended, so there is nothing to cancel.
      active = undefined;
      startup = undefined;
      await arm();
      return "extended";
    },

    recordActivity(): void {
      lastActivityAt = Date.now();
    },

    start: arm,
  };
}
