// Reads an idle checkpoint an eve 0.83 owner (checkpoint version 17) hands to a v27 successor.
// Its stream holds v26 lines, which every v27 reader already reads as the commits they record;
// the successor appends v27 lines after them. Only idle top-level sessions move. A pure upgrade
// keeps what v27 runs on unchanged and refuses anything still in flight, so the owner keeps any
// session the successor can't continue. The successor rebuilds the session's projection from
// the stream itself, in `v26-projection.ts`.
//
// Delete once no v26 owner remains.

import { usageOf } from "#harness/facts.js";
import { isObject } from "#shared/guards.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { SessionCheckpoint } from "#execution/session/handoff.js";

type CheckpointRecord = Record<string, unknown>;

/** What a v26 owner counted that the stream alone does not record, for the projection rebuild. */
export interface V26CarriedState {
  /** The sequence the session's next turn takes, so no v27 turn reuses a v26 turn's id. */
  readonly nextTurnSequence: number;
  /** Every model's spend the owner counted, including what its stream never recorded. */
  readonly usage?: Usage;
  /** The usage window the latest accepted budget prompt started. */
  readonly usageWindow?: { readonly index: number; readonly start: Usage };
}

/** Context v27 no longer reads: per-step, per-turn, and session caches it resolves again. */
const RETIRED_CONTEXT = new Set([
  "eve.dynamicInstructionResolveMessages",
  "eve.dynamicSkillManifest",
  "eve.harness.instrumentationActionScopes",
  "eve.harness.instrumentationInputScopes",
  "eve.harness.instrumentationState",
  "eve.liveStepDynamicModelSelection",
  "eve.runtimeModelMetadataCache",
  "eve.sessionDynamicInstructions",
  "eve.sessionDynamicModelReference",
  "eve.sessionDynamicSubagentRuntimeRevision",
  "eve.sessionDynamicSubagentSelections",
  "eve.sessionDynamicToolMetadata",
  "eve.sessionDynamicToolRuntimeRevision",
  "eve.stepDynamicToolMetadata",
  "eve.turnDynamicInstructions",
  "eve.turnDynamicModelReference",
  "eve.turnDynamicSubagentSelections",
  "eve.turnDynamicToolMetadata",
]);

/** Context that holds work an idle session never has; any value keeps the session on its owner. */
const IN_FLIGHT_CONTEXT = [
  "eve.activeChannelDeliveries",
  "eve.memory.pendingCommit",
  "eve.memory.preparedCompaction",
  "eve.memory.preparedPreamble",
  "eve.memory.turnLocks",
  "eve.pendingAuthorizationResult",
  "eve.pendingDynamicInstructionUserMessages",
  "eve.pendingToolInterrupts",
];

/**
 * A caller that drives the session through a v26 protocol: a parent session or a remote agent.
 * Such a session moves with its caller, which this upgrade does not follow.
 */
const CALLER_CONTEXT = ["eve.legacyRemoteAgentCaller", "eve.parentSession", "eve.sessionCallback"];

/** Framework context v27 reads in the shape v26 wrote it. */
const KEPT_CONTEXT = new Set([
  "eve.agentSessionRuntimeOverrides",
  "eve.auth",
  "eve.authorizationHook",
  "eve.bundle",
  "eve.callbackBaseUrl",
  "eve.capabilities",
  "eve.channel",
  "eve.channelDelivery",
  "eve.channelInstrumentation",
  "eve.channelRequestId",
  "eve.connectionApprovalPins",
  "eve.connectionAuthorizationResolvers",
  "eve.connectionAuthorizationTokens",
  "eve.continuationHookTokens",
  "eve.continuationToken",
  "eve.conversation",
  "eve.conversationId",
  "eve.dynamicSkillSandbox",
  "eve.dynamicSubagentAgentConfig",
  "eve.harness.agentTrace",
  "eve.harness.runtimeActionSettlementTimes",
  "eve.historyState",
  "eve.initiatorAuth",
  "eve.offeredCatalogTools",
  "eve.otelTraceEnabled",
  "eve.parentTraceContext",
  "eve.readFile",
  "eve.scheduleId",
  "eve.scheduleInstance",
  "eve.scheduleOccurrenceId",
  "eve.schedulePreparedWrites",
  "eve.session",
  "eve.sessionId",
  "eve.sessionInbox",
  "eve.sessionPredecessor",
  "eve.sessionTitle",
  "eve.sessionTraceSeed",
  "eve.stateLayout",
  "eve.staticModelReference",
  "eve.toolStubPlayback",
  "eve.toolStubs",
  "eve.traceRoot",
  "eve.turnDeliveryIds",
]);

/** Session state v27 no longer reads: caches, and records of one settled turn. */
const RETIRED_STATE = new Set([
  "eve.harness.reportedSessionUsage",
  "eve.harness.requestEnvelopeTokens",
  "eve.harness.turnClientContext",
  "eve.harness.turnTrace",
]);

/** Session state that holds work an idle session never has. */
const IN_FLIGHT_STATE = [
  "eve.harness.pendingWorkflowInterrupt",
  "eve.runtime.deferredStepInput",
  "eve.runtime.hitl.requests",
  "eve.runtime.pendingCoordinationBatch",
  "eve.runtime.pendingInputBatch",
  "eve.session.pendingHistory",
];

const PROJECTION_KEY = "eve.harness.sessionProjection";
const TURN_STATE_KEY = "eve.harness.turnState";
const TURN_USAGE_KEY = "eve.harness.turnUsage";
const WINDOW_INDEX_KEY = "eve.harness.sessionUsageWindowIndex";
const WINDOW_START_KEY = "eve.harness.sessionUsageWindowStart";

/**
 * The idle v26 checkpoint in the v27 shape, without the projection the successor rebuilds from
 * the stream, and what that rebuild needs from the checkpoint. Calls `refuse` for anything it
 * cannot carry over.
 */
export function upgradeV26Checkpoint(
  checkpoint: CheckpointRecord,
  refuse: (detail: string) => never,
): { readonly checkpoint: CheckpointRecord; readonly carried: V26CarriedState } {
  const serializedContext = upgradeContext(record(checkpoint.serializedContext, refuse), refuse);
  const sessionState = record(checkpoint.sessionState, refuse);
  if (sessionState.version !== 2 || sessionState.hasProxyInputRequests !== false)
    refuse("the durable session is not an idle version 2 session");
  const snapshot = record(sessionState.snapshot, refuse);
  const session = record(snapshot.session, refuse);
  const { state, carried } = upgradeState(
    session.state === undefined ? {} : record(session.state, refuse),
    refuse,
  );
  const { state: _state, ...rest } = session;
  return {
    carried,
    checkpoint: {
      ...checkpoint,
      serializedContext,
      sessionState: {
        ...sessionState,
        snapshot: {
          ...snapshot,
          session: Object.keys(state).length === 0 ? rest : { ...rest, state },
        },
      },
    },
  };
}

/**
 * The upgraded checkpoint with the projection the successor rebuilt from its stream. Plain data,
 * so the session workflow can apply the step's result.
 */
export function withV26Projection(
  checkpoint: SessionCheckpoint,
  projection: SessionProjection,
): SessionCheckpoint {
  const { sessionState } = checkpoint;
  const { session } = sessionState.snapshot;
  return {
    ...checkpoint,
    sessionState: {
      ...sessionState,
      snapshot: {
        ...sessionState.snapshot,
        session: { ...session, state: { ...session.state, [PROJECTION_KEY]: projection } },
      },
    },
  };
}

function upgradeContext(
  context: CheckpointRecord,
  refuse: (detail: string) => never,
): CheckpointRecord {
  for (const key of CALLER_CONTEXT)
    if (context[key] !== undefined) refuse(`a caller drives the session through "${key}"`);
  for (const key of IN_FLIGHT_CONTEXT)
    if (holds(context[key])) refuse(`the session holds in-flight "${key}"`);
  const upgraded: CheckpointRecord = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || RETIRED_CONTEXT.has(key) || IN_FLIGHT_CONTEXT.includes(key))
      continue;
    // Authored and mounted state never takes the framework's `eve.` namespace.
    if (key.startsWith("eve.") && !KEPT_CONTEXT.has(key))
      refuse(`unknown framework context "${key}"`);
    upgraded[key] = key === "eve.channel" ? upgradeChannel(record(value, refuse), refuse) : value;
  }
  return upgraded;
}

// These registries can outlive the harness request that created them. Check every channel,
// including renamed wrappers, before deciding whether its remaining state needs conversion.
const CHANNEL_PENDING_WORK = [
  "shownPromptId",
  "hitlPrompts",
  "pendingFreeformReplies",
  "pendingAuthMessageIds",
  "pendingAuthMessageTs",
  "pendingAuthActivityId",
  "pendingAuthActivityIds",
  "pendingSignIns",
  "pendingApprovalCards",
  "pendingInputCards",
  "pendingPromptCards",
  "pendingTaskResults",
  "anchorMessageId",
  "streamText",
  "streamStepIndex",
];

/** Built-in channels at their conventional paths; custom state migrations remain app-owned. */
function upgradeChannel(
  channel: CheckpointRecord,
  refuse: (detail: string) => never,
): CheckpointRecord {
  if (typeof channel.kind !== "string") refuse("the channel kind is malformed");
  if (channel.kind === "subagent") refuse("a parent session drives the session");
  const state = record(channel.state, refuse);
  for (const key of CHANNEL_PENDING_WORK)
    if (holds(state[key])) refuse(`the channel holds pending "${key}"`);
  const kind = channel.kind.startsWith("channel:") ? channel.kind.slice(8) : channel.kind;
  switch (kind) {
    case "discord": {
      const { directMessage, pendingAuthMessageIds: _ids, ...rest } = state;
      if (directMessage !== undefined && typeof directMessage !== "boolean")
        refuse("the Discord direct-message flag is malformed");
      if (directMessage === true && rest.channelType !== undefined && rest.channelType !== 1)
        refuse("the Discord channel type conflicts with its direct-message flag");
      return {
        ...channel,
        state: directMessage === true ? { ...rest, channelType: 1 } : rest,
      };
    }
    case "slack":
      return { ...channel, state: { ...state, taskCards: null } };
    case "teams": {
      const { pendingAuthActivityId: _id, ...rest } = state;
      return { ...channel, state: rest };
    }
    case "telegram": {
      // Settled v26 callbacks contain InputResponse, not Answer. Retire them rather than allow
      // an old platform button to address a new interaction; keep the monotonically growing id.
      const { hitlCallbacks: _callbacks, ...rest } = state;
      return { ...channel, state: rest };
    }
    case "chat-sdk":
    case "linq":
    case "photon": {
      const { streamStepIndex: _index, ...rest } = state;
      return { ...channel, state: rest };
    }
    default:
      // The path-derived kind cannot identify a renamed built-in. Never guess at an authored
      // channel's schema: leave it on the source when a retired format needs conversion.
      if (state.directMessage !== undefined || holds(state.hitlCallbacks) || holds(state.taskCards))
        refuse("the channel holds legacy state without a known migration");
      return channel;
  }
}

function upgradeState(
  state: CheckpointRecord,
  refuse: (detail: string) => never,
): { readonly state: CheckpointRecord; readonly carried: V26CarriedState } {
  for (const key of IN_FLIGHT_STATE)
    if (state[key] !== undefined) refuse(`the session holds in-flight "${key}"`);
  if (holds(state["eve.runtime.pendingInputBatches"])) refuse("the session holds pending input");

  const projection = record(state[PROJECTION_KEY] ?? {}, refuse);
  if (projection.activeTurnId !== undefined) refuse("a turn is still open");
  if (projection.ended === true) refuse("the session ended");
  const nextTurnSequence = projection.nextSequence ?? 0;
  if (!Number.isSafeInteger(nextTurnSequence) || (nextTurnSequence as number) < 0)
    refuse("the turn sequence is malformed");

  const turn = state[TURN_STATE_KEY];
  if (turn !== undefined) {
    const { queued, suspended } = record(turn, refuse);
    if (queued !== undefined || holds(suspended)) refuse("a turn holds queued or suspended work");
  }
  const workflowTools = state["eve.workflowTool"];
  if (workflowTools !== undefined && holds(record(workflowTools, refuse).runs))
    refuse("workflow tool runs are still open");
  const tasks = state["eve.taskTable"];
  if (tasks !== undefined) {
    const records = record(tasks, refuse).tasks;
    if (!Array.isArray(records)) refuse("the task table is malformed");
    for (const task of records) {
      const { calls, held, results, run } = record(task, refuse);
      if (run !== undefined || holds(calls) || holds(held) || holds(results))
        refuse("a task is still working, resumable, or holds undelivered results");
    }
  }
  const memory = state["eve.memory"];
  if (memory !== undefined && holds(record(memory, refuse).locks))
    refuse("a memory slot is still locked");

  const turnUsage = state[TURN_USAGE_KEY];
  const usage =
    turnUsage === undefined ? undefined : v26Usage(record(turnUsage, refuse).session, refuse);
  const windowIndex = state[WINDOW_INDEX_KEY];
  const windowStart = state[WINDOW_START_KEY];
  let usageWindow: V26CarriedState["usageWindow"];
  if (windowIndex !== undefined || windowStart !== undefined) {
    if (!Number.isSafeInteger(windowIndex) || (windowIndex as number) < 1)
      refuse("the usage window is malformed");
    usageWindow = { index: windowIndex as number, start: v26Usage(windowStart, refuse) };
  }

  const upgraded: CheckpointRecord = {};
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith("eve.")) {
      upgraded[key] = value;
      continue;
    }
    // Dropped: the stream rebuilds the projection and spend, and v27 asks again for approvals a
    // v26 `once()` remembered. Settled task, workflow, and memory records hold nothing v27 reads.
    if (
      key === PROJECTION_KEY ||
      key === TURN_STATE_KEY ||
      key === TURN_USAGE_KEY ||
      key === WINDOW_INDEX_KEY ||
      key === WINDOW_START_KEY ||
      key === "eve.workflowTool" ||
      key === "eve.taskTable" ||
      key === "eve.memory" ||
      key === "eve.runtime.pendingInputBatches" ||
      RETIRED_STATE.has(key)
    )
      continue;
    refuse(`unknown framework state "${key}"`);
  }
  return {
    carried: {
      nextTurnSequence: nextTurnSequence as number,
      ...(usage !== undefined && { usage }),
      ...(usageWindow !== undefined && { usageWindow }),
    },
    state: upgraded,
  };
}

/** A v26 usage total: its counts, and its cost only when a provider reported one. */
function v26Usage(value: unknown, refuse: (detail: string) => never): Usage {
  const totals = record(value, refuse);
  const count = (field: string) => {
    const raw = totals[field] ?? 0;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
      refuse("the session's usage is malformed");
    return raw;
  };
  return usageOf({
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    costUsd: totals.sawCost === true ? count("costUsd") : undefined,
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
  });
}

function record(value: unknown, refuse: (detail: string) => never): CheckpointRecord {
  if (!isObject(value)) refuse("the checkpoint is malformed");
  return value;
}

/** Whether a registry value holds anything: a non-empty array or record, or another value. */
function holds(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}
