/**
 * Starts every pending runtime action for the parked parent session.
 *
 * The batch is classified into a dispatch plan first (reject / start), then
 * each entry dispatches and emits one parent `subagent.called` control-plane
 * event through a single tail. Every start commits an agent handle
 * (`starting`) before its side effect and confirms it (`running`) once the
 * child reports coordinates, so the returned snapshot-bearing state owns
 * every child it may have created.
 */

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
} from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { REMOTE_AGENT_START_FAILED, SUBAGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import {
  deriveAgentId,
  getAgentHandleStore,
  type AgentIdentity,
  type StartOperation,
} from "#harness/handles/store.js";
import {
  confirmAgentStarted,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeSubagentResult,
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

type DynamicSubagentAgentConfig = NonNullable<
  Extract<
    ReturnType<typeof getDynamicSubagentSelection>,
    { readonly kind: "subagent" }
  >["agentConfig"]
>;

type DynamicRemoteAgentConfig = NonNullable<
  Extract<
    ReturnType<typeof getDynamicSubagentSelection>,
    { readonly kind: "remote" }
  >["remoteAgent"]
>;

type DispatchPlanEntry =
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: DispatchStartTarget };

type DispatchStartTarget =
  | {
      readonly kind: "local";
      readonly action: RuntimeSubagentCallActionRequest;
      readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
      readonly source: SubagentInputSource;
    }
  | {
      readonly kind: "remote";
      readonly action: RuntimeRemoteAgentCallActionRequest;
      readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
    };

export async function dispatchRuntimeActionsStep(input: {
  readonly callbackBaseUrl?: string;
  /** Internal hook that receives child completion and HITL payloads. */
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeSubagentResult[];
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

  const adapterCtx = buildAdapterContext(adapter, ctx);
  // Read here, not in the child: trace state is scoped to one session's
  // context, so this is the last place the parent's window is visible.
  const parentTraceContext = readSessionTraceContext(input.serializedContext, session.sessionId);
  // A corrupt handle store throws; surface that before anything dispatches.
  // A mid-loop throw after a sibling started would durably replay the whole
  // batch and re-dispatch that sibling.
  getAgentHandleStore(durableSession.state);
  const plan = planDispatch({ actions: batch.actions, bundle, ctx, session });
  // Acquired only once preflight can no longer throw, so a planning failure
  // never leaks the writer lock.
  const writer = input.parentWritable.getWriter();
  // Split the parent's remaining token quota across the batch's freshly
  // started local subagents, the children that actually receive an enforced
  // cap. Remote agents run on their own deployment under their own limits,
  // so they do not dilute the local shares.
  const fanoutSize = plan.filter(
    (entry) => entry.kind === "start" && entry.target.kind === "local",
  ).length;

  let nextSession = session;
  const results: RuntimeSubagentResult[] = [];

  try {
    for (const entry of plan) {
      if (entry.kind === "reject") {
        results.push(entry.result);
        continue;
      }

      const outcome: DispatchOutcome = await startSubagent({
        auth,
        batchEvent: batch.event,
        bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        capabilities,
        channelMetadata,
        currentSession: nextSession,
        fanoutSize,
        initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        parentTraceContext,
        session,
        target: entry.target,
      });

      nextSession = outcome.session;
      if (outcome.kind === "error") {
        results.push(outcome.result);
        continue;
      }

      // Emission is observability, not control flow: a failure here must not
      // escape the loop, because a durable-step retry would re-dispatch the
      // children that already started.
      try {
        const parentEvent = await callAdapterEventHandler(
          adapter,
          createSubagentCalledEvent({
            callId: outcome.callId,
            childSessionId: outcome.childSessionId,
            name: outcome.name,
            remote: outcome.remote,
            sequence: batch.event.sequence,
            sessionId: session.sessionId,
            toolName: outcome.toolName,
            turnId: batch.event.turnId,
            workflowId: workflowEntryReference.workflowId,
          }),
          adapterCtx,
        );
        await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(parentEvent)));
      } catch (error) {
        logError(log, "subagent.called emission failed", error, {
          callId: outcome.callId,
          childSessionId: outcome.childSessionId,
          toolName: outcome.toolName,
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

  return {
    results,
    sessionState: nextState,
  };
}

/**
 * Classifies every batch action before anything dispatches, so invalid
 * batches fail without starting children and rejections never interleave
 * with dispatch work.
 */
function planDispatch(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly bundle: CompiledBundle;
  readonly ctx: Parameters<typeof getDynamicSubagentSelection>[0];
  readonly session: RuntimeSession;
}): DispatchPlanEntry[] {
  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const subagentDepth = resolveSubagentDepth(input.session);
  const rootOnly = input.session.rootSessionId !== undefined || subagentDepth.currentDepth > 0;

  return input.actions.map((action): DispatchPlanEntry => {
    const isDynamicSubagent =
      (action.kind === "subagent-call" || action.kind === "remote-agent-call") &&
      input.bundle.subagentRegistry.dynamicNodeIds?.has(action.nodeId) === true;
    const dynamicSubagentSelection = isDynamicSubagent
      ? getDynamicSubagentSelection(input.ctx, action.nodeId)
      : undefined;
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
      return { kind: "reject", result: createUnavailableDynamicSubagentResult(action) };
    }

    if (isRecursiveAgentAction(action, registry) && rootOnly) {
      log.warn("recursive agent call blocked outside the root session", {
        callId: action.callId,
        currentDepth: subagentDepth.currentDepth,
        nodeId: action.nodeId,
        subagentName: action.subagentName,
      });
      return { kind: "reject", result: createRecursiveAgentRootOnlyResult(action) };
    }

    switch (action.kind) {
      case "subagent-call": {
        const dynamicAgentConfig =
          dynamicSubagentSelection?.kind === "subagent"
            ? dynamicSubagentSelection.agentConfig
            : undefined;
        const registered = registry.get(action.nodeId);
        const description =
          dynamicAgentConfig?.description ??
          (registered?.definition.kind === "subagent"
            ? registered.definition.description
            : undefined);
        const source: SubagentInputSource =
          description !== undefined ? { description, type: "local" } : { type: "runtime" };
        return {
          kind: "start",
          target: {
            action,
            dynamicSubagentAgentConfig: dynamicAgentConfig,
            kind: "local",
            source,
          },
        };
      }
      case "remote-agent-call":
        return {
          kind: "start",
          target: {
            action,
            dynamicRemoteAgent:
              dynamicSubagentSelection?.kind === "remote"
                ? dynamicSubagentSelection.remoteAgent
                : undefined,
            kind: "remote",
          },
        };
      default:
        throw new Error(`Unsupported runtime action kind "${action.kind}" in workflow runtime.`);
    }
  });
}

async function startSubagent(input: {
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly session: RuntimeSession;
  readonly target: DispatchStartTarget;
}): Promise<DispatchOutcome> {
  switch (input.target.kind) {
    case "local":
      return startLocalSubagent({
        action: input.target.action,
        auth: input.auth,
        batchEvent: input.batchEvent,
        bundle: input.bundle,
        capabilities: input.capabilities,
        channelMetadata: input.channelMetadata,
        currentSession: input.currentSession,
        dynamicSubagentAgentConfig: input.target.dynamicSubagentAgentConfig,
        fanoutSize: input.fanoutSize,
        initiatorAuth: input.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        parentTraceContext: input.parentTraceContext,
        session: input.session,
        source: input.target.source,
      });
    case "remote":
      return startRemoteSubagent({
        action: input.target.action,
        auth: input.auth,
        batchEvent: input.batchEvent,
        bundle: input.bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        currentSession: input.currentSession,
        dynamicRemoteAgent: input.target.dynamicRemoteAgent,
        initiatorAuth: input.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        session: input.session,
      });
    default: {
      const _exhaustive: never = input.target;
      return _exhaustive;
    }
  }
}

/**
 * Mints the deterministic start operation and identity for one dispatch.
 * All inputs are parent-controlled, so both exist before the child does
 * and a durable replay of the step re-derives the same ownership record.
 */
function mintStartOperation(input: {
  readonly callId: string;
  readonly name: string;
  readonly nodeId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): { readonly identity: AgentIdentity; readonly operation: StartOperation } {
  const operationId = deriveAgentOperationId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  return {
    identity: {
      id: deriveAgentId(input.name, operationId),
      name: input.name,
      nodeId: input.nodeId,
    },
    operation: {
      callId: input.callId,
      id: operationId,
      kind: "start",
      parentTurnId: input.parentTurnId,
    },
  };
}

async function startLocalSubagent(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly session: RuntimeSession;
  readonly source: SubagentInputSource;
}): Promise<DispatchOutcome> {
  const { action, source } = input;
  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    dynamicSubagentAgentConfig: input.dynamicSubagentAgentConfig,
    nodeId: action.nodeId,
  });
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    auth: input.auth,
    batchEvent: input.batchEvent,
    capabilities: input.capabilities,
    channelMetadata: input.channelMetadata,
    fanoutSize: input.fanoutSize,
    initiatorAuth: input.initiatorAuth,
    parentContinuationToken: input.parentContinuationToken,
    parentTraceContext: input.parentTraceContext,
    session: input.session,
    source,
  });

  const targetKind = source.type === "runtime" ? ("agent/self" as const) : ("agent/local" as const);
  const { identity, operation } = mintStartOperation({
    callId: action.callId,
    name: action.subagentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
  // Ownership is recorded before the start side effect, and the prepared
  // (or rejected) store rides every outcome into the step result. The
  // guarantee is intra-step: a crash between the accepted start and the
  // step-result commit still replays the whole dispatch step, so the
  // orphan window shrinks to that boundary rather than disappearing.
  const preparedSession = prepareAgentStart(input.currentSession, {
    identity,
    operation,
    target: { continuationToken: childContinuationToken, kind: targetKind },
  });

  let childSessionId: string;
  try {
    const handle = await childRuntime.run(runInput);
    childSessionId = handle.sessionId;
  } catch (error) {
    logError(log, "local subagent start failed", error, {
      callId: action.callId,
      nodeId: action.nodeId,
      subagentName: action.subagentName,
    });
    return {
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        output: {
          code: SUBAGENT_START_FAILED,
          message: toErrorMessage(error),
        },
        subagentName: action.subagentName,
      },
      session: rejectAgentEffect(preparedSession, {
        disposition: "dead",
        operationId: operation.id,
      }),
    };
  }

  return {
    callId: action.callId,
    childSessionId,
    kind: "called",
    name: action.name,
    session: confirmAgentStarted(preparedSession, {
      address: {
        continuationToken: childContinuationToken,
        kind: targetKind,
        sessionId: childSessionId,
      },
      operationId: operation.id,
    }),
    toolName: action.subagentName,
  };
}

async function startRemoteSubagent(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly auth: Parameters<typeof startRemoteAgentSession>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly currentSession: RuntimeSession;
  readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
  readonly initiatorAuth: Parameters<typeof startRemoteAgentSession>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly session: RuntimeSession;
}): Promise<DispatchOutcome> {
  const { action } = input;

  // Preflight resolution failures happen before ownership exists, so they
  // reject without touching the handle store.
  let callbackBaseUrl: string;
  let resolvedRemote: ReturnType<typeof resolveRemoteAgentForAction>;
  try {
    if (input.callbackBaseUrl === undefined) {
      throw new Error("Cannot dispatch remote agent without a callback base URL.");
    }
    callbackBaseUrl = input.callbackBaseUrl;
    resolvedRemote = resolveRemoteAgentForAction({
      dynamicRemoteAgent: input.dynamicRemoteAgent,
      nodeId: action.nodeId,
      remoteAgentName: action.remoteAgentName,
      registry: input.bundle.subagentRegistry.subagentsByNodeId,
    });
  } catch (error) {
    logError(log, "remote agent start failed", error, {
      remoteAgentName: action.remoteAgentName,
      nodeId: action.nodeId,
      callId: action.callId,
    });
    return {
      kind: "error",
      result: createRemoteAgentStartFailureResult({ action, error }),
      session: input.currentSession,
    };
  }

  const { identity, operation } = mintStartOperation({
    callId: action.callId,
    name: action.remoteAgentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
  const preparedSession = prepareAgentStart(input.currentSession, {
    identity,
    operation,
    target: { callbackBaseUrl, kind: "agent/remote", url: resolvedRemote.url },
  });

  try {
    const child = await startRemoteAgentSession({
      action,
      auth: input.auth,
      callbackBaseUrl,
      callbackToken: input.parentContinuationToken,
      initiatorAuth: input.initiatorAuth,
      remote: resolvedRemote,
      session: input.session,
    });
    return {
      callId: action.callId,
      childSessionId: child.sessionId,
      kind: "called",
      name: action.name,
      remote: { url: resolvedRemote.url },
      session: confirmAgentStarted(preparedSession, {
        address: {
          callbackBaseUrl,
          continuationToken: child.continuationToken,
          kind: "agent/remote",
          sessionId: child.sessionId,
          url: resolvedRemote.url,
        },
        operationId: operation.id,
      }),
      toolName: action.remoteAgentName,
    };
  } catch (error) {
    logError(log, "remote agent start failed", error, {
      remoteAgentName: action.remoteAgentName,
      nodeId: action.nodeId,
      callId: action.callId,
    });
    return {
      kind: "error",
      result: createRemoteAgentStartFailureResult({ action, error }),
      session: rejectAgentEffect(preparedSession, {
        disposition: "dead",
        operationId: operation.id,
      }),
    };
  }
}

function createUnavailableDynamicSubagentResult(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): RuntimeSubagentDispatchFailure {
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
}): RuntimeSubagentDispatchFailure {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: REMOTE_AGENT_START_FAILED,
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.remoteAgentName,
  };
}

function createRecursiveAgentRootOnlyResult(
  action: RuntimeSubagentCallActionRequest,
): RuntimeSubagentDispatchFailure {
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
