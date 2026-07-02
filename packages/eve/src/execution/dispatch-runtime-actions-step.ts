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
  recordPendingSubagentChildToken,
} from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
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
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import { hydrateDurableSession } from "#execution/session.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { createWorkflowRuntime, workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
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
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const adapter = ctx.require(ChannelKey);
  const auth = ctx.get(AuthKey) ?? null;
  const capabilities = ctx.get(CapabilitiesKey);
  const channelMetadata = ctx.get(ChannelInstrumentationKey);
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;
  const writer = input.parentWritable.getWriter();

  const adapterCtx = buildAdapterContext(adapter, ctx);
  const delegationLimit = resolveSubagentDelegationLimit(session);

  let nextSession = session;
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
          const registered = bundle.subagentRegistry.subagentsByNodeId.get(action.nodeId);
          const source: SubagentInputSource =
            registered?.definition.kind === "subagent"
              ? { description: registered.definition.description, type: "local" }
              : { type: "runtime" };
          const childRuntime = createWorkflowRuntime({
            compiledArtifactsSource: bundle.compiledArtifactsSource,
            nodeId: action.nodeId,
          });
          const { childContinuationToken, runInput } = buildSubagentRunInput({
            action,
            auth,
            batchEvent: batch.event,
            capabilities,
            channelMetadata,
            initiatorAuth,
            parentContinuationToken: input.parentContinuationToken,
            session,
            source,
          });
          const handle = await childRuntime.run(runInput);

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
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(parentEvent)));
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
