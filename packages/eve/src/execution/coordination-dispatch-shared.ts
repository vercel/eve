/** Shared owner-side dispatch context preparation. */

import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ActivityObserverConfig } from "#channel/types.js";
import { type ChannelAdapter, type ChannelAdapterContext } from "#channel/adapter.js";
import {
  ActivityObserverKey,
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  LocalDevRequestKey,
  type LocalDevRequestProvenance,
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
import { deserializeContext } from "#context/serialize.js";
import type { RuntimeSession } from "#subagents/handle-dispatch.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import {
  assertUniqueCoordinationCallIds,
  getPendingCoordinationBatch,
  setPendingCoordinationBatch,
} from "#harness/coordination.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type {
  RuntimeActionResult,
  RuntimeToolCallActionRequest,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import type { SessionParent } from "#channel/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { readSessionTraceContext } from "#tracing/agent-trace-context-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { isTaskControlAction } from "#execution/tasks/parent/dispatch.js";

export type DispatchPlanEntry =
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
export interface PreparedCoordinationDispatch<PlanEntry = DispatchPlanEntry> {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batch: DispatchBatch;
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  /** Number of local children sharing the parent's remaining token quota. */
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly localDevRequest?: LocalDevRequestProvenance;
  /** Lineage of the session running this dispatch, when it is itself a delegated child. */
  readonly parentSession: SessionParent | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  readonly sandboxSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly plan: readonly PlanEntry[];
  readonly session: RuntimeSession;
  readonly sessionState: DurableSessionState;
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
  const turnId = pending.event.turnId || activeTurnId(input.sessionState.emissionState);
  const event = pending.event.turnId === turnId ? pending.event : { ...pending.event, turnId };
  const ctx = await deserializeContext(input.serializedContext);
  const prepared = await prepareActionDispatch({
    batch: {
      event,
      localFanoutSize: pending.localFanoutSize,
      requests,
    },
    ctx,
    durableSession,
    plan: () => planDispatch({ requests }),
    serializedContext: input.serializedContext,
  });
  if (event === pending.event) {
    return { ...prepared, sessionState: input.sessionState };
  }

  const session = setPendingCoordinationBatch({
    ...pending,
    event,
    session: prepared.session,
  });
  return {
    ...prepared,
    session,
    sessionState: createDurableSessionState({ session }),
  };
}

type DispatchRequest = RuntimeToolCallActionRequest | RuntimeWorkflowTaskRequest;

interface DispatchBatch {
  readonly event: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly localFanoutSize?: number;
  readonly requests: readonly { readonly callId: string }[];
}

export async function prepareActionDispatch<PlanEntry>(input: {
  readonly batch: DispatchBatch;
  readonly ctx: ContextContainer;
  readonly durableSession: Awaited<ReturnType<typeof readDurableSession>>;
  readonly fanoutSize?: number;
  readonly plan: (input: {
    readonly bundle: CompiledBundle;
    readonly ctx: ContextContainer;
    readonly requests: DispatchBatch["requests"];
    readonly session: RuntimeSession;
  }) => readonly PlanEntry[];
  readonly planSharesSandbox?: (input: {
    readonly bundle: CompiledBundle;
    readonly plan: readonly PlanEntry[];
  }) => boolean;
  readonly serializedContext: Record<string, unknown>;
}): Promise<Omit<PreparedCoordinationDispatch<PlanEntry>, "sessionState">> {
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
  const plan = input.plan({
    bundle,
    ctx,
    requests: batch.requests,
    session,
  });

  const sandboxSessionId = resolveActiveSandboxSessionId(adapter.state, session.sessionId);
  if (input.planSharesSandbox?.({ bundle, plan }) === true) {
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
    fanoutSize: input.fanoutSize ?? batch.localFanoutSize ?? 0,
    initiatorAuth: ctx.get(InitiatorAuthKey) ?? null,
    localDevRequest: ctx.get(LocalDevRequestKey),
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

function resolveActiveSandboxSessionId(adapterState: unknown, sessionId: string): string {
  if (typeof adapterState !== "object" || adapterState === null) return sessionId;
  const value = (adapterState as Record<string, unknown>).sandboxSessionId;
  return typeof value === "string" && value.length > 0 ? value : sessionId;
}

function planDispatch(input: {
  readonly requests: readonly DispatchRequest[];
}): DispatchPlanEntry[] {
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
    const unsupported = request as { readonly kind?: unknown };
    throw new Error(`Unsupported coordination request "${String(unsupported.kind)}".`);
  });
}
