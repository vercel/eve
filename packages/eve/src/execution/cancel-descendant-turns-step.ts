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
import { getAgentHandleStore, type AgentHandle } from "#harness/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { ContextContainer } from "#context/container.js";

// Retry through transient world contention (queue wakes, hook-claim
// conflicts), then log loudly: a silently dropped cancel leaves the child
// running to completion with no trace of why.
const CANCEL_ATTEMPTS = 8;
const CANCEL_RETRY_INITIAL_DELAY_MS = 250;
const CANCEL_RETRY_MAX_DELAY_MS = 1_500;
const log = createLogger("execution.cancel-descendant-turns");

type RunningAgentHandle = Extract<AgentHandle, { phase: "running" }>;

/** Cancels every running delegated child recorded in the agent handle store. */
export async function cancelDescendantTurnsStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let running: readonly RunningAgentHandle[];
  try {
    const session = await readDurableSession(input.sessionState);
    running = (getAgentHandleStore(session.state)?.handles ?? []).filter(
      (handle): handle is RunningAgentHandle => handle.phase === "running",
    );
  } catch (error) {
    logError(log, "failed to read pending descendants during cancellation", error, {
      sessionId: input.sessionState.sessionId,
    });
    return;
  }

  if (running.length === 0) {
    log.warn("no running agent handles found while cancelling descendants; nothing to cancel", {
      sessionId: input.sessionState.sessionId,
    });
    return;
  }

  let remoteContext:
    | Promise<{
        readonly ctx: ContextContainer;
        readonly registry: RuntimeSubagentRegistry["subagentsByNodeId"];
      }>
    | undefined;
  const getRemoteContext = () =>
    (remoteContext ??= deserializeContext(input.serializedContext).then((ctx) => ({
      ctx,
      registry: ctx.require(BundleKey).subagentRegistry.subagentsByNodeId,
    })));

  await Promise.all(
    running.map((handle) =>
      handle.address.kind === "agent/remote"
        ? cancelRemoteDescendant({ handle, remoteContext: getRemoteContext() })
        : cancelLocalDescendant({ handle }),
    ),
  );
}

async function cancelLocalDescendant(input: {
  readonly handle: RunningAgentHandle;
}): Promise<void> {
  const { handle } = input;
  try {
    const final = await requestCancellationWithRetry({
      request: () => requestWorkflowTurnCancellation({ sessionId: handle.address.sessionId }),
      shouldRetryError: () => false,
    });
    if (final.status !== "accepted") {
      log.warn("descendant cancel was never accepted; the child may run to completion", {
        callId: handle.operation.callId,
        childSessionId: handle.address.sessionId,
        finalStatus: final.status,
        reason: final.reason,
        subagentName: handle.identity.name,
      });
    }
  } catch (error) {
    logError(log, "failed to cancel local descendant turn", error, {
      callId: handle.operation.callId,
      childSessionId: handle.address.sessionId,
      subagentName: handle.identity.name,
    });
  }
}

async function cancelRemoteDescendant(input: {
  readonly remoteContext: Promise<{
    readonly ctx: ContextContainer;
    readonly registry: RuntimeSubagentRegistry["subagentsByNodeId"];
  }>;
  readonly handle: RunningAgentHandle;
}): Promise<void> {
  const { handle } = input;
  if (handle.address.kind !== "agent/remote") {
    return;
  }
  const childUrl = handle.address.url;
  try {
    const { ctx, registry } = await input.remoteContext;
    const selection = getDynamicSubagentSelection(ctx, handle.identity.nodeId);
    const resolved = await resolveRemoteAgentForAction({
      dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
      nodeId: handle.identity.nodeId,
      remoteAgentName: handle.identity.name,
      registry,
    });
    // Cancel where the child actually runs: the registry URL may point at a
    // newer deployment than the one that adopted this child, so the
    // dispatch-recorded URL wins — mirroring continuation delivery.
    const remote = { ...resolved, url: childUrl };

    const final = await requestCancellationWithRetry({
      request: () => cancelRemoteAgentTurn({ remote, sessionId: handle.address.sessionId }),
      shouldRetryError: isRetryableRemoteAgentCancelError,
    });
    if (final.status !== "accepted") {
      log.warn("remote descendant cancel was never accepted; the child may run to completion", {
        callId: handle.operation.callId,
        childSessionId: handle.address.sessionId,
        finalStatus: final.status,
        reason: final.reason,
        remoteAgentName: handle.identity.name,
      });
    }
  } catch (error) {
    logError(log, "failed to cancel remote descendant turn", error, {
      callId: handle.operation.callId,
      childSessionId: handle.address.sessionId,
      remoteAgentName: handle.identity.name,
    });
  }
}

async function requestCancellationWithRetry(input: {
  readonly request: () => Promise<CancelTurnResult>;
  readonly shouldRetryError: (error: unknown) => boolean;
}): Promise<CancelTurnResult> {
  let delayMs = CANCEL_RETRY_INITIAL_DELAY_MS;
  let lastResult: CancelTurnResult = { status: "no_active_turn" };

  for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt += 1) {
    try {
      lastResult = await input.request();
      if (lastResult.status === "accepted" || attempt === CANCEL_ATTEMPTS) return lastResult;
    } catch (error) {
      if (!input.shouldRetryError(error) || attempt === CANCEL_ATTEMPTS) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, CANCEL_RETRY_MAX_DELAY_MS);
  }

  return lastResult;
}
