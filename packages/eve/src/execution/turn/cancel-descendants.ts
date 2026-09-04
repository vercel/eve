import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { readDurableSession, type DurableSessionState } from "#execution/session/state.js";
import { cancelRemoteAgentTurn, resolveRemoteAgentForAction } from "#subagents/remote-dispatch.js";
import { cancelWorkflowToolRun } from "#execution/workflow-tool/cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { getWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getAgentHandleStore, type AgentHandle } from "#subagents/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { ContextContainer } from "#context/container.js";

const log = createLogger("execution.cancel-descendant-turns");

type RunningAgentHandle = Extract<AgentHandle, { phase: "claimed" | "running" }>;

/**
 * Cancels every running delegated child recorded in the agent handle store
 * and every workflow tool run the turn is waiting on.
 */
export async function cancelDescendantTurns(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  const session = await readDurableSession(input.sessionState);
  const workflowToolRuns = getWorkflowToolRuns(session.state);
  const workflowOwnerIds = new Set(workflowToolRuns.map((run) => run.runId));
  const running = (getAgentHandleStore(session.state)?.handles ?? []).filter(
    (handle): handle is RunningAgentHandle =>
      handle.phase === "running" ||
      (handle.phase === "claimed" && workflowOwnerIds.has(handle.ownerId)),
  );
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

  const outcomes = await Promise.allSettled([
    ...workflowToolRuns.map((record) =>
      cancelWorkflowToolRun(record, "The turn that called the tool was cancelled."),
    ),
    ...running.map((handle) =>
      handle.address.kind === "agent/remote"
        ? cancelRemoteDescendant({ handle, remoteContext: getRemoteContext() })
        : cancelLocalDescendant({ handle }),
    ),
  ]);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length > 0)
    throw new AggregateError(errors, "Descendant cancellation did not complete.");
}

async function cancelLocalDescendant(input: {
  readonly handle: RunningAgentHandle;
}): Promise<void> {
  const { handle } = input;
  try {
    const final = await requestWorkflowTurnCancellation({ sessionId: handle.address.sessionId });
    if (final.status !== "accepted") {
      log.debug("descendant has no active turn", {
        callId: readHandleCallId(handle),
        childSessionId: handle.address.sessionId,
        finalStatus: final.status,
        subagentName: handle.identity.name,
      });
    }
  } catch (error) {
    logError(log, "failed to cancel local descendant turn", error, {
      callId: readHandleCallId(handle),
      childSessionId: handle.address.sessionId,
      subagentName: handle.identity.name,
    });
    throw error;
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

    const final = await cancelRemoteAgentTurn({ remote, sessionId: handle.address.sessionId });
    if (final.status !== "accepted") {
      log.debug("remote descendant has no active turn", {
        callId: readHandleCallId(handle),
        childSessionId: handle.address.sessionId,
        finalStatus: final.status,
        remoteAgentName: handle.identity.name,
      });
    }
  } catch (error) {
    logError(log, "failed to cancel remote descendant turn", error, {
      callId: readHandleCallId(handle),
      childSessionId: handle.address.sessionId,
      remoteAgentName: handle.identity.name,
    });
    throw error;
  }
}

function readHandleCallId(handle: RunningAgentHandle): string | undefined {
  return handle.phase === "running" ? handle.operation.callId : handle.callId;
}
