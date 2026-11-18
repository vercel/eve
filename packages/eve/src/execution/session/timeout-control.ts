import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  cancelSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session/timeout-steps.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

export interface SessionTimeoutControl {
  getDeadline(): Date;
  dispose(): Promise<void>;
  handleTimerElapsed(): Promise<"expired" | "extended">;
  recordActivity(): void;
  start(): Promise<void>;
}

export interface SessionTimeoutInput {
  readonly deadline?: Date;
  readonly sessionId: string;
  readonly timeoutMs: number | false;
}

export type SessionTimeouts = (input: SessionTimeoutInput) => SessionTimeoutControl | undefined;

export function createSessionTimeoutControl(
  input: SessionTimeoutInput,
): SessionTimeoutControl | undefined {
  const { sessionId, timeoutMs } = input;
  if (timeoutMs === false) return undefined;
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
      } catch {}
      if (active === undefined) return;
      const current = active;
      active = undefined;
      await cancelSessionTimeoutStep({ runId: current.runId });
    },

    async handleTimerElapsed(): Promise<"expired" | "extended"> {
      if (Date.now() >= lastActivityAt + timeoutMs) return "expired";
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
