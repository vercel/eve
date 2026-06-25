import { deserializeContext } from "#context/serialize.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { buildRuntimeActionsFromWorkflowInterrupt } from "#harness/workflow-runtime-action-state.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";

/** Dispatches the child-agent action currently blocking a dynamic workflow. */
export async function dispatchWorkflowRuntimeActionsStep(input: {
  readonly callbackBaseUrl?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeSubagentResultActionResult[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const pending = getPendingWorkflowInterrupt(durableSession.state);
  if (pending === undefined) return { results: [], sessionState: input.sessionState };

  const actions = buildRuntimeActionsFromWorkflowInterrupt(pending.interrupt);
  if (actions.length === 0) return { results: [], sessionState: input.sessionState };

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });

  const sessionWithBatch = setPendingRuntimeActionBatch({
    actions,
    event: { sequence: 0, stepIndex: 0, turnId: "workflow-dispatch" },
    responseMessages: [],
    session,
  });

  return dispatchRuntimeActionsStep({
    callbackBaseUrl: input.callbackBaseUrl,
    parentWritable: input.parentWritable,
    serializedContext: input.serializedContext,
    sessionState: createDurableSessionState({ session: sessionWithBatch }),
  });
}
