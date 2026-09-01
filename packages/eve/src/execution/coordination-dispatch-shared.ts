/**
 * Shared task/control planning, child startup, and replay-safe
 * `subagent.called` emission used by the turn owner and workflow tasks.
 */

import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ActivityObserverConfig } from "#channel/types.js";
import { type ChannelAdapter, type ChannelAdapterContext } from "#channel/adapter.js";
import {
  ActivityObserverKey,
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  ParentSessionKey,
  SandboxKey,
} from "#context/keys.js";
import { ContextContainer } from "#context/container.js";
import { withContextScope } from "#context/run-step.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import { deserializeContext } from "#context/serialize.js";
import {
  isAgentHandleAction,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#subagents/handle-dispatch.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import {
  assertUniqueCoordinationCallIds,
  getPendingCoordinationBatch,
} from "#harness/coordination.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeActionResult,
  RuntimeSubagentDispatchRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeToolCallActionRequest,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import type { SessionParent } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  createRecursiveAgentRootOnlyResult,
  createUnavailableDynamicSubagentResult,
  getSubagentName,
} from "#execution/dispatch-action-failures.js";
import { hydrateDurableSession } from "#execution/session.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#subagents/tool.js";
import type { DispatchStartTarget } from "#execution/tools/subagent/start.js";
import { createLogger } from "#internal/logging.js";
import { readSessionTraceContext } from "#tracing/agent-trace-context-store.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { isTaskControlAction } from "#execution/tasks/parent/dispatch.js";

const log = createLogger("execution.dispatch-coordination");

export type DispatchPlanEntry =
  | {
      readonly kind: "resume";
      readonly action: RuntimeAgentHandleAction;
      readonly agentId: string;
      readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
    }
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: DispatchStartTarget }
  | { readonly kind: "task-control"; readonly action: RuntimeToolCallActionRequest }
  | { readonly kind: "workflow-task"; readonly task: RuntimeWorkflowTaskRequest };

/** Input shared by direct and Workflow-originated owner-side dispatch. */
export interface CoordinationDispatchInput {
  readonly callbackBaseUrl?: string;
  /** Internal hook that receives child completion and HITL payloads. */
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Owner-side results plus any task-control work that still needs acknowledgement. */
export interface CoordinationDispatchResult {
  readonly results: readonly RuntimeActionResult[];
  readonly sessionState: DurableSessionState;
  readonly pendingTasks: readonly {
    readonly taskInboxToken: string;
    readonly taskId: string;
    readonly taskRunId: string;
  }[];
}

/** Everything preflight produces before either step's dispatch loop runs. */
export interface PreparedCoordinationDispatch {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batch: DispatchBatch;
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  /**
   * Number of freshly started local subagents in the plan. The parent's
   * remaining token quota is split across these, the children that
   * actually receive an enforced cap: continuations already run under
   * their own budget, and remote agents run on their own deployment
   * under their own limits, so neither dilutes the local shares.
   */
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  /** Lineage of the session running this dispatch, when it is itself a delegated child. */
  readonly parentSession: SessionParent | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  readonly sandboxSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly plan: readonly DispatchPlanEntry[];
  readonly session: RuntimeSession;
}

/**
 * Runs every dispatch precondition that may throw — durable reads, context
 * deserialization, handle-store validation, and batch planning — before
 * the caller acquires the parent stream writer, so a preflight failure
 * never leaks the writer lock. Returns undefined when no actions are
 * pending.
 */
export async function prepareCoordinationDispatch(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<PreparedCoordinationDispatch | undefined> {
  const durableSession = await readDurableSession(input.sessionState);
  const pending = getPendingCoordinationBatch(durableSession.state);

  if (pending === undefined) return undefined;
  const requests = [...pending.runtimeActions, ...pending.tasks];
  if (requests.length === 0) return undefined;
  const ctx = await deserializeContext(input.serializedContext);
  return await prepareActionDispatch({
    batch: {
      event: pending.event,
      localFanoutSize: pending.localFanoutSize,
      requests,
    },
    ctx,
    durableSession,
    serializedContext: input.serializedContext,
  });
}

type DispatchRequest =
  | RuntimeAgentDispatchRequest
  | RuntimeToolCallActionRequest
  | RuntimeWorkflowTaskRequest;

interface DispatchBatch {
  readonly event: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly localFanoutSize?: number;
  readonly requests: readonly DispatchRequest[];
}

export async function prepareActionDispatch(input: {
  readonly batch: DispatchBatch;
  readonly ctx: ContextContainer;
  readonly durableSession: Awaited<ReturnType<typeof readDurableSession>>;
  readonly fanoutSize?: number;
  /** Explicit handle ids for owners whose registry lives outside session state. */
  readonly knownAgentIds?: readonly string[];
  readonly serializedContext: Record<string, unknown>;
}): Promise<PreparedCoordinationDispatch> {
  const { batch, durableSession } = input;
  assertUniqueCoordinationCallIds(batch.requests);

  const ctx = input.ctx;
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  let session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const adapter = ctx.require(ChannelKey);

  // A corrupt handle store and rejected actions must resolve before sandbox
  // initialization, which can provision backend resources and run onSession.
  getAgentHandleStore(durableSession.state);
  const plan = planDispatch({
    requests: batch.requests,
    bundle,
    ctx,
    knownAgentIds: input.knownAgentIds,
    session,
  });

  const sandboxSessionId = resolveActiveSandboxSessionId(adapter.state, session.sessionId);
  if (planSharesSandbox({ bundle, plan })) {
    try {
      const scoped = await withContextScope(ctx, session, async (enrichedSession) => {
        await ctx.require(SandboxKey).get();
        return { result: undefined, session: enrichedSession };
      });
      session = scoped.session;
    } finally {
      ctx.clearVirtualContext();
    }
  }

  return {
    adapter,
    adapterCtx: buildAdapterContext(adapter, ctx),
    auth: ctx.get(AuthKey) ?? null,
    batch,
    bundle,
    capabilities: ctx.get(CapabilitiesKey),
    channelMetadata: ctx.get(ChannelInstrumentationKey),
    fanoutSize:
      input.fanoutSize ??
      batch.localFanoutSize ??
      plan.filter((entry) => entry.kind === "start" && entry.target.kind === "local").length,
    initiatorAuth: ctx.get(InitiatorAuthKey) ?? null,
    parentSession: ctx.get(ParentSessionKey),
    parentTraceContext: readSessionTraceContext(input.serializedContext, session.sessionId),
    plan,
    activityObserver: resolvePreparedActivity(
      ctx.get(ActivityObserverKey),
      session,
      batch.event.turnId,
    ),
    sandboxSessionId,
    serializedContext: input.serializedContext,
    session,
  };
}

function resolvePreparedActivity(
  activityObserver: ActivityObserverConfig | undefined,
  session: RuntimeSession,
  turnId: string,
): (ActivityObserverConfig & { readonly workIdentity: ActivityWorkIdentityV1 }) | undefined {
  if (activityObserver === undefined) return undefined;
  return {
    sink: activityObserver.sink,
    workIdentity: activityObserver.workIdentity ?? {
      id: deriveRootTurnActivityWorkId({ sessionId: session.sessionId, turnId }),
      kind: "root-turn",
      rootSessionId: session.rootSessionId ?? session.sessionId,
      rootTurnId: turnId,
      sessionId: session.sessionId,
      turnId,
    },
  };
}

function planSharesSandbox(input: {
  readonly bundle: CompiledBundle;
  readonly plan: readonly DispatchPlanEntry[];
}): boolean {
  const graph = (input.bundle as Partial<CompiledBundle>).graph;
  return input.plan.some((entry) => {
    if (entry.kind !== "start" || entry.target.kind !== "local") return false;
    const action = entry.target.action;
    const isSelfDelegation =
      action.subagentName === "agent" &&
      !input.bundle.subagentRegistry.subagentsByNodeId.has(action.nodeId);
    return (
      isSelfDelegation ||
      graph?.nodesByNodeId.get(action.nodeId)?.sandboxRegistry.sandbox.definition.inheritsParent ===
        true
    );
  });
}

function resolveActiveSandboxSessionId(adapterState: unknown, sessionId: string): string {
  if (typeof adapterState !== "object" || adapterState === null) return sessionId;
  const value = (adapterState as Record<string, unknown>).sandboxSessionId;
  return typeof value === "string" && value.length > 0 ? value : sessionId;
}

/**
 * Emits the parent `subagent.called` control-plane event for one adopted
 * child. Emission is observability, not control flow: a failure is logged
 * and swallowed, because a throw escaping the dispatch loop would durably
 * replay the step and re-dispatch children that already started.
 */
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
  readonly requests: readonly DispatchRequest[];
  readonly bundle: CompiledBundle;
  readonly ctx: Parameters<typeof getDynamicSubagentSelection>[0];
  readonly knownAgentIds?: readonly string[];
  readonly session: RuntimeSession;
}): DispatchPlanEntry[] {
  const knownAgentIds =
    input.knownAgentIds === undefined
      ? new Set(
          (getAgentHandleStore(input.session.state)?.handles ?? []).map(
            (handle) => handle.identity.id,
          ),
        )
      : new Set(input.knownAgentIds);

  return input.requests.map((request): DispatchPlanEntry => {
    if (request.kind === "tool-call") {
      if (!isTaskControlAction(request)) {
        throw new Error(`Unsupported task control "${request.toolName}".`);
      }
      return { action: request, kind: "task-control" };
    }
    if (request.kind === "workflow-task") {
      return { kind: "workflow-task", task: request };
    }
    const action = request;

    const rawAgentId = action.input.agentId;
    const agentId =
      typeof rawAgentId === "string" && rawAgentId.trim() !== "" ? rawAgentId : undefined;
    if (agentId !== undefined && isAgentHandleAction(action)) {
      // Resume classification runs before the recursion guard: an agentId
      // continuation resumes an already-adopted child rather than starting
      // a new one. Unknown ids go through classifyFreshStart below, which
      // re-applies the guard the resume path bypasses.
      if (knownAgentIds.has(agentId)) {
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
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: Parameters<typeof getDynamicSubagentSelection>[0];
  readonly session: RuntimeSession;
}): Extract<DispatchPlanEntry, { kind: "reject" | "start" }> {
  const { action } = input;
  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const delegated = input.session.rootSessionId !== undefined;

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

  if (isRecursiveAgentAction(action, registry) && delegated) {
    log.warn("recursive agent call blocked outside the root session", {
      callId: action.callId,
      nodeId: action.nodeId,
      rootSessionId: input.session.rootSessionId,
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
        description !== undefined
          ? {
              description,
              outputSchema:
                dynamicAgentConfig?.outputSchema ??
                input.bundle.graph?.nodesByNodeId.get(action.nodeId)?.turnAgent?.outputSchema,
              type: "local",
            }
          : { outputSchema: input.bundle.turnAgent.outputSchema, type: "runtime" };
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
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function isRecursiveAgentAction(
  action: RuntimeAgentDispatchRequest,
  subagentsByNodeId: ReadonlyMap<string, unknown>,
): action is RuntimeSubagentDispatchRequest {
  return (
    action.kind === "subagent-call" &&
    action.subagentName === "agent" &&
    !subagentsByNodeId.has(action.nodeId)
  );
}
