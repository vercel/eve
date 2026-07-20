import type { CancelTurnResult } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  cancelRemoteAgentTurn,
  isRetryableRemoteAgentCancelError,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";

const CANCEL_ATTEMPTS = 12;
const CANCEL_RETRY_DELAY_MS = 250;
const log = createLogger("execution.cancel-descendant-turns");

/** Cancels every successfully adopted child in the current pending batch. */
export async function cancelDescendantTurnsStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let batch;
  try {
    const session = await readDurableSession(input.sessionState);
    batch = getPendingRuntimeActionBatch(session.state);
  } catch (error) {
    logError(log, "failed to read pending descendants during cancellation", error, {
      sessionId: input.sessionState.sessionId,
    });
    return;
  }

  if (batch === undefined) return;
  const childSessionIds = batch.childSessionIds;
  if (childSessionIds === undefined) return;

  let remoteRegistry: Promise<RuntimeSubagentRegistry["subagentsByNodeId"]> | undefined;
  const getRemoteRegistry = () =>
    (remoteRegistry ??= deserializeContext(input.serializedContext).then(
      (ctx) => ctx.require(BundleKey).subagentRegistry.subagentsByNodeId,
    ));

  const cancellations = batch.actions.flatMap((action): Promise<void>[] => {
    const childSessionId = childSessionIds[action.callId];
    if (childSessionId === undefined) return [];

    if (action.kind === "subagent-call") {
      return [cancelLocalDescendant({ action, childSessionId })];
    }
    if (action.kind === "remote-agent-call") {
      return [
        cancelRemoteDescendant({
          action,
          childSessionId,
          remoteRegistry: getRemoteRegistry(),
        }),
      ];
    }
    return [];
  });

  await Promise.all(cancellations);
}

async function cancelLocalDescendant(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly childSessionId: string;
}): Promise<void> {
  try {
    await requestCancellationWithRetry({
      request: () => requestWorkflowTurnCancellation({ sessionId: input.childSessionId }),
      shouldRetryError: () => false,
    });
  } catch (error) {
    logError(log, "failed to cancel local descendant turn", error, {
      callId: input.action.callId,
      childSessionId: input.childSessionId,
      subagentName: input.action.subagentName,
    });
  }
}

async function cancelRemoteDescendant(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly childSessionId: string;
  readonly remoteRegistry: Promise<RuntimeSubagentRegistry["subagentsByNodeId"]>;
}): Promise<void> {
  try {
    const registry = await input.remoteRegistry;
    const remote = resolveRemoteAgentForAction({
      nodeId: input.action.nodeId,
      remoteAgentName: input.action.remoteAgentName,
      registry,
    });

    await requestCancellationWithRetry({
      request: () => cancelRemoteAgentTurn({ remote, sessionId: input.childSessionId }),
      shouldRetryError: isRetryableRemoteAgentCancelError,
    });
  } catch (error) {
    logError(log, "failed to cancel remote descendant turn", error, {
      callId: input.action.callId,
      childSessionId: input.childSessionId,
      remoteAgentName: input.action.remoteAgentName,
    });
  }
}

async function requestCancellationWithRetry(input: {
  readonly request: () => Promise<CancelTurnResult>;
  readonly shouldRetryError: (error: unknown) => boolean;
}): Promise<void> {
  for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt += 1) {
    try {
      const result = await input.request();
      if (result.status === "accepted" || attempt === CANCEL_ATTEMPTS) return;
    } catch (error) {
      if (!input.shouldRetryError(error) || attempt === CANCEL_ATTEMPTS) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, CANCEL_RETRY_DELAY_MS));
  }
}
