/**
 * Dispatches runtime actions originating from code mode.
 *
 * Reads the pending code mode runtime action from session state,
 * builds a runtime action request from the interrupt payload, stores
 * it as a temporary PendingRuntimeActionBatch, and delegates to the
 * standard dispatch step. The batch is only needed for dispatch —
 * the harness never sees it because results flow through
 * continuePendingCodeModeRuntimeAction, not resolvePendingRuntimeActions.
 */

import { buildRuntimeActionFromInterrupt } from "#harness/code-mode-runtime-action-state.js";
import { getPendingCodeModeInterrupt } from "#harness/code-mode-interrupt-state.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";

export async function dispatchCodeModeRuntimeActionsStep(input: {
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
  const codeModeAction = getPendingCodeModeInterrupt(durableSession.state);

  if (codeModeAction === undefined) {
    return { results: [], sessionState: input.sessionState };
  }

  const action = buildRuntimeActionFromInterrupt(codeModeAction.interrupt);

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
    actions: [action],
    event: { sequence: 0, stepIndex: 0, turnId: "code-mode-dispatch" },
    responseMessages: [],
    session,
  });

  const batchState = createDurableSessionState({ session: sessionWithBatch });

  return dispatchRuntimeActionsStep({
    callbackBaseUrl: input.callbackBaseUrl,
    parentWritable: input.parentWritable,
    serializedContext: input.serializedContext,
    sessionState: batchState,
  });
}
