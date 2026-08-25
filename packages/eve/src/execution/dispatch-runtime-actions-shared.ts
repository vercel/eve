/**
 * Machinery shared by the two runtime-action dispatch steps:
 * `dispatchRuntimeActionsStep` (plain mode) and `dispatchTaskStep`
 * (task mode). Both run the same preflight → plan → dispatch → emit
 * skeleton over one pending batch and differ only in the per-entry
 * delegation lifecycle, so planning, subagent starts, and the
 * replay-safe `subagent.called` emission tail live here.
 */

import { buildAdapterContext } from "#channel/adapter-context.js";
import {
  callAdapterEventHandler,
  type ChannelAdapter,
  type ChannelAdapterContext,
} from "#channel/adapter.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  SandboxKey,
} from "#context/keys.js";
import { type AlsContext, ContextContainer } from "#context/container.js";
import { withContextScope } from "#context/run-step.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  type DispatchOutcome,
  isAgentHandleAction,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import {
  readChildInstrumentationTraceContext,
  readSessionInstrumentationTraceContext,
} from "#instrumentation/propagation.js";
import {
  assertUniqueRuntimeActionCallIds,
  getPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeToolCallActionRequest,
} from "#shared/action-types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  createRecursiveAgentRootOnlyResult,
  createUnavailableDynamicSubagentResult,
  getSubagentName,
} from "#execution/dispatch-action-failures.js";
import { startLocalSubagent } from "#execution/subagent-start-local.js";
import { startRemoteSubagent } from "#execution/subagent-start-remote.js";
import { hydrateDurableSession } from "#execution/session.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { isTaskControlAction } from "#execution/tasks/parent/dispatch.js";

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

export type DispatchPlanEntry =
  | {
      readonly kind: "resume";
      readonly action: RuntimeAgentHandleAction;
      readonly agentId: string;
      readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
    }
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: DispatchStartTarget }
  | { readonly kind: "task-control"; readonly action: RuntimeToolCallActionRequest };

export type DispatchStartTarget =
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

/** Input contract shared by both dispatch steps so the turn workflow can select either. */
export interface RuntimeActionDispatchInput {
  readonly callbackBaseUrl?: string;
  /** Internal hook that receives child completion and HITL payloads. */
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Result contract shared by both dispatch steps. `pendingTasks` is
 * always empty in plain mode; keeping it on both keeps the turn
 * workflow's acknowledgement call site uniform.
 */
export interface RuntimeActionDispatchResult {
  readonly results: readonly RuntimeActionResult[];
  readonly sessionState: DurableSessionState;
  readonly pendingTasks: readonly {
    readonly taskInboxToken: string;
    readonly taskId: string;
    readonly taskRunId: string;
  }[];
}

/** Everything preflight produces before either step's dispatch loop runs. */
export interface PreparedRuntimeActionDispatch {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batch: NonNullable<ReturnType<typeof getPendingRuntimeActionBatch>>;
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
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
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
export async function prepareRuntimeActionDispatch(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  /**
   * Classify task-control calls as
   * task-control plan entries. Only task mode plans them; in plain mode
   * those calls fail as unsupported batch actions.
   */
  readonly taskControls: boolean;
}): Promise<PreparedRuntimeActionDispatch | undefined> {
  const durableSession = await readDurableSession(input.sessionState);
  const batch = getPendingRuntimeActionBatch(durableSession.state);

  if (batch === undefined || batch.actions.length === 0) return undefined;
  const ctx = await deserializeContext(input.serializedContext);
  return await prepareActionDispatch({
    batch,
    ctx,
    durableSession,
    serializedContext: input.serializedContext,
    taskControls: input.taskControls,
  });
}

export async function prepareAgentActionDispatch(input: {
  readonly action: RuntimeActionRequest;
  readonly ctx: AlsContext;
  readonly event: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly localFanoutSize: number;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<PreparedRuntimeActionDispatch> {
  const durableSession = await readDurableSession(input.sessionState);
  return await prepareActionDispatch({
    batch: { actions: [input.action], event: input.event, responseMessages: [] },
    ctx: copyDurableContext(input.ctx),
    durableSession,
    fanoutSize: input.localFanoutSize,
    serializedContext: input.serializedContext,
    taskControls: false,
  });
}

function copyDurableContext(ctx: AlsContext): ContextContainer {
  const copy = new ContextContainer();
  for (const [key, value] of ctx.entries()) copy.set(key, value);
  return copy;
}

async function prepareActionDispatch(input: {
  readonly batch: NonNullable<ReturnType<typeof getPendingRuntimeActionBatch>>;
  readonly ctx: ContextContainer;
  readonly durableSession: Awaited<ReturnType<typeof readDurableSession>>;
  readonly fanoutSize?: number;
  readonly serializedContext: Record<string, unknown>;
  readonly taskControls: boolean;
}): Promise<PreparedRuntimeActionDispatch> {
  const { batch, durableSession } = input;
  assertUniqueRuntimeActionCallIds(batch.actions);

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
    actions: batch.actions,
    bundle,
    ctx,
    session,
    taskControls: input.taskControls,
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
      plan.filter((entry) => entry.kind === "start" && entry.target.kind === "local").length,
    initiatorAuth: ctx.get(InitiatorAuthKey) ?? null,
    parentTraceContext: readSessionInstrumentationTraceContext(
      input.serializedContext,
      session.sessionId,
    ),
    plan,
    sandboxSessionId,
    serializedContext: input.serializedContext,
    session,
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
export async function emitSubagentCalled(input: {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly entry: Extract<DispatchPlanEntry, { readonly kind: "resume" | "start" }>;
  readonly outcome: Extract<DispatchOutcome, { readonly kind: "called" }>;
  readonly sessionId: string;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<void> {
  const { entry, outcome } = input;
  try {
    const action = entry.kind === "resume" ? entry.action : entry.target.action;
    const dynamicRemoteAgent =
      entry.kind === "resume"
        ? entry.dynamicRemoteAgent
        : entry.target.kind === "remote"
          ? entry.target.dynamicRemoteAgent
          : undefined;
    const parentEvent = await callAdapterEventHandler(
      input.adapter,
      createSubagentCalledEvent({
        callId: outcome.callId,
        childSessionId: outcome.address.sessionId,
        name: outcome.name,
        remote:
          outcome.address.kind === "agent/remote"
            ? {
                // The proxy route re-resolves outbound auth from this key via
                // resolveRemoteAgentStreamHeaders: a node id lands in
                // subagentRegistry.subagentsByNodeId (static definition), a
                // credentialsStepId lands in the step registry (dynamic
                // definition). Both sides of this ternary must stay in sync
                // with that lookup order.
                resolverId:
                  dynamicRemoteAgent === undefined
                    ? action.nodeId
                    : dynamicRemoteAgent.credentialsStepId,
                url: outcome.address.url,
              }
            : undefined,
        sequence: input.batchEvent.sequence,
        sessionId: input.sessionId,
        toolName: outcome.toolName,
        turnId: input.batchEvent.turnId,
        workflowId: workflowEntryReference.workflowId,
      }),
      input.adapterCtx,
    );
    await input.writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(parentEvent)));
  } catch (error) {
    logError(log, "subagent.called emission failed", error, {
      callId: outcome.callId,
      childSessionId: outcome.address.sessionId,
      toolName: outcome.toolName,
    });
  }
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
  readonly taskControls: boolean;
}): DispatchPlanEntry[] {
  const handles = getAgentHandleStore(input.session.state)?.handles ?? [];

  return input.actions.map((action): DispatchPlanEntry => {
    if (input.taskControls && isTaskControlAction(action)) {
      return { action, kind: "task-control" };
    }

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
    default:
      throw new Error(`Unsupported runtime action kind "${action.kind}" in workflow runtime.`);
  }
}

/** Starts one planned fresh child against its local or remote target. */
export async function startSubagent(input: {
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
  readonly sandboxSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly session: RuntimeSession;
  readonly taskOwned: boolean;
  readonly target: DispatchStartTarget;
}): Promise<DispatchOutcome> {
  const parentTraceContext =
    readChildInstrumentationTraceContext({
      callId: input.target.action.callId,
      serializedContext: input.serializedContext,
      sessionId: input.session.sessionId,
      turnId: input.batchEvent.turnId,
    }) ?? input.parentTraceContext;

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
        parentTraceContext,
        sandboxSessionId: input.sandboxSessionId,
        session: input.session,
        source: input.target.source,
        taskOwned: input.taskOwned,
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
        parentTraceContext,
        session: input.session,
        taskOwned: input.taskOwned,
      });
    default: {
      const _exhaustive: never = input.target;
      return _exhaustive;
    }
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
