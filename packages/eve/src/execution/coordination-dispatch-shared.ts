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
} from "#context/keys.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { ContextContainer } from "#context/container.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import type { HarnessSession } from "#harness/types.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import {
  assertUniqueCoordinationCallIds,
  getPendingCoordinationBatch,
  setPendingCoordinationBatch,
} from "#harness/coordination.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { RuntimeActionResult, RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { SessionParent } from "#channel/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { buildSubagentRunInput } from "#subagents/tool.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { WorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";
import { resolveWorkflowAgentMetadata } from "#execution/agent-sessions/metadata.js";
import { readDynamicSubagentSelections } from "#context/dynamic-subagent-lifecycle.js";
import type { DynamicSubagentSelections } from "#execution/agent-sessions/target.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";

/** Input shared by direct and Workflow-originated owner-side dispatch. */
export interface CoordinationDispatchInput {
  readonly workflowToolRunOwner: WorkflowToolRunOwner;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Owner-side results and the updated session, and context when hooks ran. */
export interface CoordinationDispatchResult {
  readonly results: readonly RuntimeActionResult[];
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Everything preflight produces before either step's dispatch loop runs. */
export interface PreparedCoordinationDispatch<PlanEntry = RuntimeWorkflowTaskRequest> {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batch: DispatchBatch;
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly dynamicSubagentSelections: DynamicSubagentSelections;
  readonly inheritedConversation: Parameters<
    typeof buildSubagentRunInput
  >[0]["inheritedConversation"];
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  /** Inherited originating-client metadata for the dev-TUI hint. */
  readonly localDevRequest?: LocalDevRequestProvenance;
  /** Lineage of the session running this dispatch, when it is itself a delegated child. */
  readonly parentSession: SessionParent | undefined;
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  readonly sandboxSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly plan: readonly PlanEntry[];
  readonly session: HarnessSession;
  readonly sessionState: DurableSessionState;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentMetadata>>;
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
  const durableSession = readDurableSession(input.sessionState);
  const pending = getPendingCoordinationBatch(durableSession.state);

  if (pending === undefined) return undefined;
  const requests = pending.tasks;
  if (requests.length === 0) return undefined;
  const turnId = pending.event.turnId || activeTurnId(input.sessionState.emissionState);
  const event = pending.event.turnId === turnId ? pending.event : { ...pending.event, turnId };
  const ctx = await deserializeContext(input.serializedContext);
  const prepared = await prepareActionDispatch({
    batch: {
      event,
      requests,
    },
    ctx,
    durableSession,
    plan: () => requests,
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

interface DispatchBatch {
  readonly event: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly requests: readonly { readonly callId: string }[];
}

export async function prepareActionDispatch<PlanEntry>(input: {
  readonly batch: DispatchBatch;
  readonly ctx: ContextContainer;
  readonly durableSession: Awaited<ReturnType<typeof readDurableSession>>;
  readonly plan: (input: {
    readonly bundle: CompiledBundle;
    readonly ctx: ContextContainer;
    readonly requests: DispatchBatch["requests"];
    readonly session: HarnessSession;
  }) => readonly PlanEntry[];
  readonly serializedContext: Record<string, unknown>;
}): Promise<Omit<PreparedCoordinationDispatch<PlanEntry>, "sessionState">> {
  const { batch, durableSession } = input;
  assertUniqueCoordinationCallIds(batch.requests);

  const ctx = input.ctx;
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

  const plan = input.plan({
    bundle,
    ctx,
    requests: batch.requests,
    session,
  });

  const sandboxSessionId = resolveActiveSandboxSessionId(adapter.state, session.sessionId);

  return {
    adapter,
    adapterCtx: buildAdapterContext(adapter, ctx),
    auth: ctx.get(AuthKey) ?? null,
    batch,
    bundle,
    capabilities: ctx.get(CapabilitiesKey),
    channelMetadata: ctx.get(ChannelInstrumentationKey),
    dynamicSubagentSelections: readDynamicSubagentSelections(ctx),
    inheritedConversation: ctx.get(ConversationContextKey),
    initiatorAuth: ctx.get(InitiatorAuthKey) ?? null,
    localDevRequest: ctx.get(LocalDevRequestKey),
    parentSession: ctx.get(ParentSessionKey),
    plan,
    activityObserver: resolvePreparedActivity(
      ctx.get(ActivityObserverKey),
      session,
      batch.event.turnId,
    ),
    sandboxSessionId,
    serializedContext: input.serializedContext,
    session,
    workflowAgents: resolveWorkflowAgentMetadata(ctx),
  };
}

function resolvePreparedActivity(
  activityObserver: ActivityObserverConfig | undefined,
  session: HarnessSession,
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
