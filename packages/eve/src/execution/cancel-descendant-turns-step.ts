import type { CancelTurnResult } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  cancelRemoteAgentTurn,
  isRetryableRemoteAgentCancelError,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import {
  isRetryableInactiveCancelReason,
  requestWorkflowTurnCancellation,
} from "#execution/turn-cancellation-request.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";

// This step is the durable backstop behind the request-time fan-out
// (`cancelTurnWithDescendantFanout`), which usually reaches descendants
// before the parent's run ever wakes. By the time this step executes, a
// child with no active turn was most often already cancelled at request
// time — a terminal outcome, returned immediately. Only reasons that can
// heal with time (hook-claim conflicts during queue wakes) are retried,
// and an exhausted retry is logged loudly rather than dropped silently.
const CANCEL_ATTEMPTS = 8;
const CANCEL_RETRY_INITIAL_DELAY_MS = 250;
const CANCEL_RETRY_MAX_DELAY_MS = 1_500;
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

  if (batch === undefined) {
    log.warn("no pending batch found while cancelling descendants; nothing to cancel", {
      sessionId: input.sessionState.sessionId,
    });
    return;
  }
  const childSessionIds = batch.childSessionIds;
  if (childSessionIds === undefined) {
    log.warn("pending batch carries no child session ids; descendants cannot be cancelled", {
      actionCount: batch.actions.length,
      sessionId: input.sessionState.sessionId,
    });
    return;
  }

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
    const final = await requestCancellationWithRetry({
      request: () => requestWorkflowTurnCancellation({ sessionId: input.childSessionId }),
      shouldRetryError: () => false,
      shouldRetryResult: (result) => isRetryableInactiveCancelReason(result.reason),
    });
    if (final.status !== "accepted") {
      if (isRetryableInactiveCancelReason(final.reason)) {
        log.warn("descendant cancel was never accepted; the child may run to completion", {
          callId: input.action.callId,
          childSessionId: input.childSessionId,
          finalStatus: final.status,
          reason: final.reason,
          subagentName: input.action.subagentName,
        });
      } else {
        log.info("descendant had no active turn at settle time; already cancelled or finished", {
          callId: input.action.callId,
          childSessionId: input.childSessionId,
          reason: final.reason,
          subagentName: input.action.subagentName,
        });
      }
    }
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

    const final = await requestCancellationWithRetry({
      request: () => cancelRemoteAgentTurn({ remote, sessionId: input.childSessionId }),
      shouldRetryError: isRetryableRemoteAgentCancelError,
      // The remote deployment already classified its own turn state; a
      // remote no_active_turn is terminal.
      shouldRetryResult: () => false,
    });
    if (final.status !== "accepted") {
      log.info(
        "remote descendant had no active turn at settle time; already cancelled or finished",
        {
          callId: input.action.callId,
          childSessionId: input.childSessionId,
          finalStatus: final.status,
          reason: final.reason,
          remoteAgentName: input.action.remoteAgentName,
        },
      );
    }
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
  readonly shouldRetryResult: (result: CancelTurnResult) => boolean;
}): Promise<CancelTurnResult> {
  let delayMs = CANCEL_RETRY_INITIAL_DELAY_MS;
  let lastResult: CancelTurnResult = { status: "no_active_turn" };

  for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt += 1) {
    try {
      lastResult = await input.request();
      if (
        lastResult.status === "accepted" ||
        !input.shouldRetryResult(lastResult) ||
        attempt === CANCEL_ATTEMPTS
      ) {
        return lastResult;
      }
    } catch (error) {
      if (!input.shouldRetryError(error) || attempt === CANCEL_ATTEMPTS) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, CANCEL_RETRY_MAX_DELAY_MS);
  }

  return lastResult;
}
