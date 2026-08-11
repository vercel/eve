/**
 * Starts or continues every pending runtime action for the parked parent
 * session.
 *
 * The batch is classified into a dispatch plan first (reject / resume /
 * start), then each entry dispatches and emits one
 * parent `subagent.called` control-plane event through a single tail.
 * Every start commits an agent handle (`starting`) before its side effect
 * and confirms it (`running`) once the child reports coordinates, so the
 * returned snapshot-bearing state owns every child it may have created.
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
import {
  dispatchToAgentHandle,
  isAgentHandleAction,
  type DispatchOutcome,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import { SUBAGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
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
import {
  createRecursiveAgentRootOnlyResult,
  createRemoteAgentStartFailureResult,
  createUnavailableDynamicSubagentResult,
  getSubagentName,
} from "#execution/dispatch-action-failures.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
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
  | {
      readonly kind: "resume";
      readonly action: RuntimeAgentHandleAction;
      readonly agentId: string;
      readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
    }
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
  const persistentSessions =
    bundle.resolvedAgent.config?.experimental?.subagentPersistentSessions === true;
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
  // cap. Continuations already run under their own budget, and remote agents
  // run on their own deployment under their own limits, so neither dilutes
  // the local shares.
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

      let outcome: DispatchOutcome;
      switch (entry.kind) {
        case "resume":
          outcome = await dispatchToAgentHandle({
            action: entry.action,
            agentId: entry.agentId,
            bundle: createAgentContinuationBundle({
              action: entry.action,
              bundle,
              dynamicRemoteAgent: entry.dynamicRemoteAgent,
            }),
            currentSession: nextSession,
            parentToken: input.parentContinuationToken ?? session.continuationToken,
            parentTurnId: batch.event.turnId,
          });
          break;
        case "start":
          outcome = await startSubagent({
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
            persistentSessions,
            session,
            target: entry.target,
          });
          break;
      }

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
            childSessionId: outcome.address.sessionId,
            name: outcome.name,
            remote:
              outcome.address.kind === "agent/remote" ? { url: outcome.address.url } : undefined,
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
          childSessionId: outcome.address.sessionId,
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
 *
 * This is the single place that decides fresh start vs. continuation:
 * an omitted, null, empty, or whitespace-only agentId is a fresh start
 * (strict tool-calling providers force every schema property to be present,
 * so models emit `""`/`null` when they mean "no continuation"), and an
 * agentId that matches no stored handle also falls back to a fresh start —
 * models sometimes pass a hallucinated or stale id, and hard-failing made
 * them conclude the subagent itself was unavailable. Only an id that
 * resolves to a stored handle becomes a resume.
 */
function planDispatch(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly bundle: CompiledBundle;
  readonly ctx: Parameters<typeof getDynamicSubagentSelection>[0];
  readonly session: RuntimeSession;
}): DispatchPlanEntry[] {
  const handles = getAgentHandleStore(input.session.state)?.handles ?? [];

  return input.actions.map((action): DispatchPlanEntry => {
    const rawAgentId = action.input.agentId;
    const agentId =
      typeof rawAgentId === "string" && rawAgentId.trim() !== "" ? rawAgentId : undefined;
    if (agentId !== undefined && isAgentHandleAction(action)) {
      // Resume classification runs before the recursion guard: an agentId
      // continuation resumes an already-adopted child rather than starting
      // a new one. Unknown ids go through classifyFreshStart below, which
      // re-applies the guard the resume path bypasses.
      if (handles.some((handle) => handle.identity.id === agentId)) {
        const dynamicSubagentSelection =
          input.bundle.subagentRegistry.dynamicNodeIds?.has(action.nodeId) === true
            ? getDynamicSubagentSelection(input.ctx, action.nodeId)
            : undefined;
        return {
          action,
          agentId,
          dynamicRemoteAgent:
            action.kind === "remote-agent-call" && dynamicSubagentSelection?.kind === "remote"
              ? dynamicSubagentSelection.remoteAgent
              : undefined,
          kind: "resume",
        };
      }
      log.warn("unknown agentId on subagent call; starting a new agent", {
        agentId,
        callId: action.callId,
      });
    }

    return classifyFreshStart({
      action,
      bundle: input.bundle,
      ctx: input.ctx,
      session: input.session,
    });
  });
}

/**
 * Classifies one action for fresh dispatch: rejected by the recursion guard,
 * or started against a local/remote target. Shared by plain starts and the
 * unknown-agentId fallback, so both paths enforce the same guard.
 */
function classifyFreshStart(input: {
  readonly action: RuntimeActionRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: Parameters<typeof getDynamicSubagentSelection>[0];
  readonly session: RuntimeSession;
}): Extract<DispatchPlanEntry, { kind: "reject" | "start" }> {
  const { action } = input;
  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const subagentDepth = resolveSubagentDepth(input.session);
  const rootOnly = input.session.rootSessionId !== undefined || subagentDepth.currentDepth > 0;

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
  readonly persistentSessions: boolean;
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
        persistentSessions: input.persistentSessions,
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
        persistentSessions: input.persistentSessions,
        session: input.session,
      });
    default: {
      const _exhaustive: never = input.target;
      return _exhaustive;
    }
  }
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
  readonly persistentSessions: boolean;
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
    persistentSessions: input.persistentSessions,
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
    const handle = await childRuntime.createSession(runInput);
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
        origin: "dispatch",
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

  const address = {
    continuationToken: childContinuationToken,
    kind: targetKind,
    sessionId: childSessionId,
  } as const;
  return {
    address,
    callId: action.callId,
    kind: "called",
    name: action.name,
    session: confirmAgentStarted(preparedSession, {
      address,
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
  readonly persistentSessions: boolean;
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
      persistentSessions: input.persistentSessions,
      remote: resolvedRemote,
      session: input.session,
    });
    const address = {
      callbackBaseUrl,
      kind: "agent/remote",
      sessionId: child.sessionId,
      url: resolvedRemote.url,
    } as const;
    return {
      address,
      callId: action.callId,
      kind: "called",
      name: action.name,
      session: confirmAgentStarted(preparedSession, {
        address,
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
