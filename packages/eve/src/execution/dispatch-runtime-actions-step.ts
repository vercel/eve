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
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
} from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
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
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";

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
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const adapter = ctx.require(ChannelKey);
  const auth = ctx.get(AuthKey) ?? null;
  const capabilities = ctx.get(CapabilitiesKey);
  const channelMetadata = ctx.get(ChannelInstrumentationKey);
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;
  const writer = input.parentWritable.getWriter();

  const adapterCtx = buildAdapterContext(adapter, ctx);
  const subagentDepth = resolveSubagentDepth(session);
  // Read here, not in the child: trace state is scoped to one session's
  // context, so this is the last place the parent's window is visible.
  const parentTraceContext = readSessionTraceContext(input.serializedContext, session.sessionId);
  // Split the parent's remaining token quota across the batch's local
  // subagent calls, the children that actually receive an enforced cap.
  // Remote agents run on their own deployment under their own limits and
  // do not dilute the local shares.
  const fanoutSize = batch.actions.filter((action) => action.kind === "subagent-call").length;

  let nextSession = session;
  const results: RuntimeSubagentResultActionResult[] = [];

  try {
    for (const action of batch.actions) {
      const isDynamicSubagent =
        (action.kind === "subagent-call" || action.kind === "remote-agent-call") &&
        bundle.subagentRegistry.dynamicNodeIds?.has(action.nodeId) === true;
      const dynamicSubagentSelection = isDynamicSubagent
        ? getDynamicSubagentSelection(ctx, action.nodeId)
        : undefined;
      if (
        isRecursiveAgentAction(action, bundle.subagentRegistry.subagentsByNodeId) &&
        (session.rootSessionId !== undefined || subagentDepth.currentDepth > 0)
      ) {
        log.warn("recursive agent call blocked outside the root session", {
          callId: action.callId,
          currentDepth: subagentDepth.currentDepth,
          nodeId: action.nodeId,
          subagentName: action.subagentName,
        });
        results.push(createRecursiveAgentRootOnlyResult(action));
        continue;
      }

      if (
        isDynamicSubagent &&
        (dynamicSubagentSelection === undefined ||
          (action.kind === "subagent-call" && dynamicSubagentSelection.kind !== "subagent") ||
          (action.kind === "remote-agent-call" && dynamicSubagentSelection.kind !== "remote"))
      ) {
        const subagentName = getSubagentName(action);
        log.warn("dynamic subagent call blocked after availability changed", {
          callId: action.callId,
          nodeId: action.nodeId,
          subagentName,
        });
        results.push(createUnavailableDynamicSubagentResult(action));
        continue;
      }

      let childSessionId: string;
      let name: string;
      let remote: { readonly url: string } | undefined;
      let toolName: string;

      switch (action.kind) {
        case "subagent-call": {
          const dynamicAgentConfig =
            dynamicSubagentSelection?.kind === "subagent"
              ? dynamicSubagentSelection.agentConfig
              : undefined;
          const registered = bundle.subagentRegistry.subagentsByNodeId.get(action.nodeId);
          const description =
            dynamicAgentConfig?.description ??
            (registered?.definition.kind === "subagent"
              ? registered.definition.description
              : undefined);
          const source: SubagentInputSource =
            description !== undefined ? { description, type: "local" } : { type: "runtime" };
          const childRuntime = createWorkflowRuntime({
            compiledArtifactsSource: bundle.compiledArtifactsSource,
            dynamicSubagentAgentConfig: dynamicAgentConfig,
            nodeId: action.nodeId,
          });
          const { childContinuationToken, runInput } = buildSubagentRunInput({
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
          try {
            const handle = await childRuntime.run(runInput);
            childSessionId = handle.sessionId;
          } catch (error) {
            logError(log, "local subagent start failed", error, {
              callId: action.callId,
              nodeId: action.nodeId,
              subagentName: action.subagentName,
            });
            results.push({
              callId: action.callId,
              isError: true,
              kind: "subagent-result",
              output: {
                code: "SUBAGENT_START_FAILED",
                message: toErrorMessage(error),
              },
              subagentName: action.subagentName,
            });
            continue;
          }

          nextSession = recordPendingSubagentChild({
            callId: action.callId,
            child: {
              continuationToken: childContinuationToken,
              kind: "local",
              sessionId: childSessionId,
            },
            session: nextSession,
          });
          name = action.name;
          toolName = action.subagentName;
          break;
        }
        case "remote-agent-call": {
          let resolvedRemote;
          try {
            resolvedRemote = await resolveRemoteAgentForAction({
              dynamicRemoteAgent:
                dynamicSubagentSelection?.kind === "remote"
                  ? dynamicSubagentSelection.remoteAgent
                  : undefined,
              nodeId: action.nodeId,
              remoteAgentName: action.remoteAgentName,
              registry: bundle.subagentRegistry.subagentsByNodeId,
            });
            childSessionId = await startRemoteAgentSession({
              action,
              auth,
              callbackBaseUrl: input.callbackBaseUrl,
              callbackToken: input.parentContinuationToken,
              initiatorAuth,
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
          nextSession = recordPendingSubagentChild({
            callId: action.callId,
            child: { kind: "remote", sessionId: childSessionId },
            session: nextSession,
          });
          break;
        }
        default:
          throw new Error(`Unsupported runtime action kind "${action.kind}" in workflow runtime.`);
      }

      const parentEvent = await callAdapterEventHandler(
        adapter,
        createSubagentCalledEvent({
          callId: action.callId,
          childSessionId,
          name,
          remote,
          sequence: batch.event.sequence,
          sessionId: session.sessionId,
          toolName,
          turnId: batch.event.turnId,
          workflowId: workflowEntryReference.workflowId,
        }),
        adapterCtx,
      );
      await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(parentEvent)));
    }
  } finally {
    writer.releaseLock();
  }

  const nextState =
    nextSession === session
      ? input.sessionState
      : createDurableSessionState({ session: nextSession });

  return { results, sessionState: nextState };
}

function createUnavailableDynamicSubagentResult(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): RuntimeSubagentResultActionResult {
  const subagentName = getSubagentName(action);
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "SUBAGENT_UNAVAILABLE",
      message: `Subagent "${subagentName}" is not available in the current session context.`,
    },
    subagentName,
  };
}

function getSubagentName(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): string {
  return action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
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

function createRecursiveAgentRootOnlyResult(
  action: RuntimeSubagentCallActionRequest,
): RuntimeSubagentResultActionResult {
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "RECURSIVE_AGENT_ROOT_ONLY",
      message: 'The built-in "agent" tool is only available to the root session.',
    },
    subagentName: action.subagentName,
  };
}

function isRecursiveAgentAction(
  action: RuntimeActionRequest,
  subagentsByNodeId: ReadonlyMap<string, unknown>,
): action is RuntimeSubagentCallActionRequest {
  return (
    action.kind === "subagent-call" &&
    action.subagentName === "agent" &&
    !subagentsByNodeId.has(action.nodeId)
  );
}
