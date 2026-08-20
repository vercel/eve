import { sleep } from "#compiled/@workflow/core/index.js";

import { refreshLocalSubagentWorkStep } from "#execution/refresh-local-subagent-work-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

export const LOCAL_SUBAGENT_WORK_REFRESH_MS = 10_000;

export interface LocalSubagentWorkMonitorInput {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Polls direct local subagent work without participating in parent turn control flow. */
export async function localSubagentWorkMonitorWorkflow(
  input: LocalSubagentWorkMonitorInput,
): Promise<void> {
  "use workflow";

  let serializedContext = input.serializedContext;
  let poll = 0;
  console.error("[eve.work] local subagent work monitor started", {
    parentSessionId: input.sessionState.sessionId,
  });
  while (true) {
    poll += 1;
    console.error("[eve.work] local subagent work monitor poll", {
      parentSessionId: input.sessionState.sessionId,
      poll,
    });
    const refreshed = await refreshLocalSubagentWorkStep({
      serializedContext,
      sessionState: input.sessionState,
    });
    serializedContext = refreshed.serializedContext;
    console.error("[eve.work] local subagent work monitor refresh complete", {
      ...refreshed.poll,
      hasRunningLocalSubagents: refreshed.hasRunningLocalSubagents,
      parentSessionId: input.sessionState.sessionId,
      poll,
    });
    if (!refreshed.hasRunningLocalSubagents) {
      console.error("[eve.work] local subagent work monitor settled", {
        parentSessionId: input.sessionState.sessionId,
        poll,
      });
      return;
    }
    console.error("[eve.work] local subagent work monitor sleeping", {
      durationMs: LOCAL_SUBAGENT_WORK_REFRESH_MS,
      parentSessionId: input.sessionState.sessionId,
      poll,
    });
    await sleep(LOCAL_SUBAGENT_WORK_REFRESH_MS);
  }
}
