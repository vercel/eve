/**
 * Starts every pending runtime action for the parked parent session.
 *
 * Each child run starts in task mode, emits a parent `subagent.called`
 * control-plane event, and then runs independently on its own child
 * stream. Records each child's continuation token on the parent
 * session and returns the updated snapshot-bearing state.
 */

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { withContextScope } from "#context/run-step.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChildToken,
} from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { setChannelContext } from "#execution/channel-context.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import { hydrateDurableSession } from "#execution/session.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { createWorkflowRuntime, workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { readSessionTraceContext } from "#tracing/agent-trace-context-store.js";
import {
  type DelegatedRuntimeActionRequest,
  getSubagentDelegationName,
  isSubagentDelegationAction,
  resolveSubagentDelegationLimit,
  type SubagentDelegationLimit,
} from "#harness/subagent-depth.js";

const log = createLogger("execution.dispatch-runtime-actions");

export async function dispatchRuntimeActionsStep(input: {
  readonly callbackBaseUrl?: string;
  /** Internal hook that receives child completion and HITL payloads. */
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeSubagentResultActionResult[];
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const batch = getPendingRuntimeActionBatch(durableSession.state);

  if (batch === undefined || batch.actions.length === 0) {
    return { results: [], sessionState: input.sessionState };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  // Validate this required dependency before any externally visible child
  // start. A missing channel after the first start would otherwise retry the
  // whole durable step and duplicate that child.
  ctx.require(ChannelKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const auth = ctx.get(AuthKey) ?? null;
  const capabilities = ctx.get(CapabilitiesKey);
  const channelMetadata = ctx.get(ChannelInstrumentationKey);
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;
  const writer = input.parentWritable.getWriter();

  const delegationLimit = resolveSubagentDelegationLimit(session);
  // Read here, not in the child: trace state is scoped to one session's
  // context, so this is the last place the parent's window is visible.
  const parentTraceContext = readSessionTraceContext(input.serializedContext, session.sessionId);
  // Split the parent's remaining token quota across the batch's local
  // subagent calls, the children that actually receive an enforced cap.
  // Remote agents run on their own deployment under their own limits and
  // do not dilute the local shares.
  const fanoutSize = batch.actions.filter((action) => action.kind === "subagent-call").length;

  let nextSession = session;
  let updatedContext = false;
  const results: RuntimeSubagentResultActionResult[] = [];

  try {
    for (const action of batch.actions) {
      if (delegationLimit.reached && isSubagentDelegationAction(action)) {
        log.warn("subagent depth limit reached; blocking delegated call", {
          callId: action.callId,
          currentDepth: delegationLimit.currentDepth,
          maxDepth: delegationLimit.maxDepth,
          nodeId: action.nodeId,
          subagentName: getSubagentDelegationName(action),
        });
        results.push(createSubagentDepthLimitResult({ action, delegationLimit }));
        continue;
      }

      let childSessionId: string;
      let name: string;
      let remote: { readonly url: string } | undefined;
      let toolName: string;

      switch (action.kind) {
        case "subagent-call": {
          let childContinuationToken: string;
          let handle: { readonly sessionId: string };
          try {
            const registered = bundle.subagentRegistry.subagentsByNodeId.get(action.nodeId);
            const source: SubagentInputSource =
              registered?.definition.kind === "subagent"
                ? { description: registered.definition.description, type: "local" }
                : { type: "runtime" };
            const childRuntime = createWorkflowRuntime({
              compiledArtifactsSource: bundle.compiledArtifactsSource,
              nodeId: action.nodeId,
            });
            const built = buildSubagentRunInput({
              action,
              auth,
              batchEvent: batch.event,
              capabilities,
              channelMetadata,
              fanoutSize,
              initiatorAuth,
              parentContinuationToken: input.parentContinuationToken,
              parentTraceContext,
              session,
              source,
            });
            childContinuationToken = built.childContinuationToken;
            handle = await childRuntime.run(built.runInput);
          } catch (error) {
            logError(log, "subagent start failed", error, {
              callId: action.callId,
              nodeId: action.nodeId,
              subagentName: action.subagentName,
            });
            results.push(createSubagentStartFailureResult({ action, error }));
            continue;
          }

          nextSession = recordPendingSubagentChildToken({
            callId: action.callId,
            childContinuationToken,
            session: nextSession,
          });
          childSessionId = handle.sessionId;
          name = action.name;
          toolName = action.subagentName;
          break;
        }
        case "remote-agent-call": {
          let resolvedRemote;
          try {
            resolvedRemote = resolveRemoteAgentForAction({
              nodeId: action.nodeId,
              remoteAgentName: action.remoteAgentName,
              registry: bundle.subagentRegistry.subagentsByNodeId,
            });
            childSessionId = await startRemoteAgentSession({
              action,
              callbackBaseUrl: input.callbackBaseUrl,
              callbackToken: input.parentContinuationToken,
              remote: resolvedRemote,
              session,
            });
          } catch (error) {
            logError(log, "remote agent start failed", error, {
              remoteAgentName: action.remoteAgentName,
              nodeId: action.nodeId,
              callId: action.callId,
            });
            results.push(createRemoteAgentStartFailureResult({ action, error }));
            continue;
          }
          name = action.name;
          remote = { url: resolvedRemote.url };
          toolName = action.remoteAgentName;
          break;
        }
        default:
          throw new Error(`Unsupported runtime action kind "${action.kind}" in workflow runtime.`);
      }

      const parentEvent = createSubagentCalledEvent({
        callId: action.callId,
        childSessionId,
        name,
        remote,
        sequence: batch.event.sequence,
        sessionId: session.sessionId,
        toolName,
        turnId: batch.event.turnId,
        workflowId: workflowEntryReference.workflowId,
      });
      try {
        const scopedAdapter = ctx.require(ChannelKey);
        if (scopedAdapter[parentEvent.type] === undefined) {
          await writeParentEventBestEffort({ event: parentEvent, writer });
          continue;
        }

        const continuationTokenBeforeHandler = ctx.get(ContinuationTokenKey);
        const scopeResult = await withContextScope(ctx, nextSession, async (scopedSession) => {
          const eventAdapter = ctx.require(ChannelKey);
          const adapterCtx = buildAdapterContext(eventAdapter, ctx);
          const transformedEvent = await callAdapterEventHandler(
            eventAdapter,
            parentEvent,
            adapterCtx,
          );
          setChannelContext(ctx, { ...eventAdapter, state: { ...adapterCtx.state } });
          await writeParentEventBestEffort({ event: transformedEvent, writer });

          const continuationTokenChanged =
            ctx.get(ContinuationTokenKey) !== continuationTokenBeforeHandler;
          return {
            result: undefined,
            session: continuationTokenChanged
              ? reconcileSessionContinuationToken(ctx, scopedSession)
              : scopedSession,
          };
        });
        nextSession = scopeResult.session;
        updatedContext = true;
      } catch (error) {
        // Child creation is externally visible and cannot be rolled back. Never
        // let best-effort notification/context work retry this whole dispatch
        // step and launch the same child again.
        logError(log, "subagent.called notification failed after child start", error, {
          callId: action.callId,
          childSessionId,
          subagentName: toolName,
        });
      }
    }
  } finally {
    writer.releaseLock();
  }

  const nextState =
    nextSession === session
      ? input.sessionState
      : createDurableSessionState({ session: nextSession });

  let serializedContext: Record<string, unknown> | undefined;
  if (updatedContext) {
    try {
      serializedContext = serializeContext(ctx);
    } catch (error) {
      // An authored handler can leave non-serializable adapter state behind.
      // Losing that best-effort mutation is safer than retrying child creation.
      logError(log, "subagent.called context serialization failed after child start", error);
    }
  }

  const output: {
    results: readonly RuntimeSubagentResultActionResult[];
    serializedContext?: Record<string, unknown>;
    sessionState: DurableSessionState;
  } = {
    results,
    sessionState: nextState,
  };
  if (serializedContext !== undefined) output.serializedContext = serializedContext;
  return output;
}

async function writeParentEventBestEffort(input: {
  readonly event: HandleMessageStreamEvent;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<void> {
  try {
    await input.writer.write(
      encodeMessageStreamEvent(timestampHandleMessageStreamEvent(input.event)),
    );
  } catch (error) {
    logError(log, "subagent.called stream write failed after child start", error, {
      eventType: input.event.type,
    });
  }
}

function createSubagentStartFailureResult(input: {
  readonly action: Extract<DelegatedRuntimeActionRequest, { readonly kind: "subagent-call" }>;
  readonly error: unknown;
}): RuntimeSubagentResultActionResult {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "SUBAGENT_START_FAILED",
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.subagentName,
  };
}

function createRemoteAgentStartFailureResult(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly error: unknown;
}): RuntimeSubagentResultActionResult {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "REMOTE_AGENT_START_FAILED",
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.remoteAgentName,
  };
}

function createSubagentDepthLimitResult(input: {
  readonly action: DelegatedRuntimeActionRequest;
  readonly delegationLimit: SubagentDelegationLimit;
}): RuntimeSubagentResultActionResult {
  const subagentName = getSubagentDelegationName(input.action);
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "SUBAGENT_DEPTH_LIMIT_REACHED",
      currentDepth: input.delegationLimit.currentDepth,
      maxDepth: input.delegationLimit.maxDepth,
      message: `Subagent depth limit reached (${input.delegationLimit.maxDepth}); "${subagentName}" was not called.`,
    },
    subagentName,
  };
}
