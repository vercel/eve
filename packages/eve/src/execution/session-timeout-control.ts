import {
  cancelSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session-timeout-steps.js";

/** Workflow-body handle that targets a durable deadline at the active delivery hook. */
export interface SessionTimeoutControl {
  dispose(): Promise<void>;
  rekey(token: string): Promise<void>;
}

/** Creates a timer controller that preserves one absolute session deadline across hook rekeys. */
export function createSessionTimeoutControl(input: {
  readonly deadline: Date;
}): SessionTimeoutControl {
  let active: { readonly runId: string; readonly token: string } | undefined;

  return {
    async dispose(): Promise<void> {
      if (active === undefined) return;
      const current = active;
      active = undefined;
      await cancelSessionTimeoutStep({ runId: current.runId });
    },

    async rekey(token: string): Promise<void> {
      if (!token || active?.token === token) return;

      if (active !== undefined) {
        await cancelSessionTimeoutStep({ runId: active.runId });
      }

      const { runId } = await startSessionTimeoutStep({
        deadline: input.deadline,
        token,
      });
      active = { runId, token };
    },
  };
}
