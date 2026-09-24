import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload, TaskStartedHookPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { projectToDurableSession } from "#execution/session.js";
import { startSubagent } from "#execution/tools/subagent/start.js";
import type { InternalAgentInput } from "#execution/tools/subagent/invoke-agent.js";
import {
  classifyFreshStart,
  ownerPlanReusesSandbox,
  resolveAgentInvocationAction,
} from "#execution/tools/subagent/invoke-preparation.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { clearProxyInputRequestsForChild } from "#harness/proxy-input-requests.js";
import {
  accumulateSessionUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { settledEvents, taskSettledEvent, taskStartedEvent } from "#tasks/events.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeSubagentChildResult,
  RuntimeSubagentResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  AGENT_BUSY,
  AGENT_UNREACHABLE,
  SUBAGENT_EXECUTION_FAILED,
} from "#subagents/agent-handle-errors.js";
import { createAgentContinuationBundle } from "#subagents/continuation-bundle.js";
import { prepareAgentInvocationTrace } from "#tracing/agent-invocation-coordinator.js";
import {
  flushAgentInvocationTraces,
  settleAgentInvocationTrace,
} from "#tracing/agent-invocation-terminal.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { agentTaskCallFromRequest, isAgentTaskRequest } from "#tasks/agent-tool.js";
import { isTerminalTaskStatus, type ChildAddress } from "#tasks/protocol.js";
import { createFailedResult, toTaskError, toTaskOutcome, toToolResult } from "#tasks/outcome.js";
import { deliverToChild, runCommands, type CommandEffect } from "#tasks/transport.js";
import {
  ownerInboxHookToken,
  readTaskCallbackAlias,
  setTaskTable,
  TASK_CALLBACK_ALIAS_PREFIX,
  TASK_CALLBACK_ALIAS_STATE_KEY,
} from "#tasks/state.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  applyTaskMessage,
  cancelTask,
  DEFAULT_AGENT_TIMEOUT_MS,
  findTask,
  markTaskDelivered,
  readTaskTable,
  startTask,
  type TaskEffect,
  type TaskTable,
} from "#tasks/table.js";

const log = createLogger("tasks.owner");

/** One agent call: from the model, or from `ctx.agent` inside a workflow tool body. */
export interface AgentTaskCall {
  readonly callId: string;
  readonly input: InternalAgentInput;
  readonly toolName?: string;
  readonly workflowCaller?: TaskRecord["workflowCaller"];
}

/** A result owed to a `ctx.agent` caller. */
export interface WorkflowCallerReply {
  readonly replyTo: string;
  readonly result: RuntimeSubagentResult;
}

/** What the session body does after an owner step: publish events and resolve callers. */
export interface TaskOwnerUpdate {
  /** `task.*` lifecycle events: one `task.settled` per generation, whichever path settles it. */
  readonly events: readonly UnstampedMessageStreamEvent[];
  /** Tool results for waited model calls. */
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly replies: readonly WorkflowCallerReply[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Mints the owner's remote callback alias if it has none. It runs before any
 * start step, so the alias is recorded and claimed before a remote child
 * could call back, and a retried start step reuses it.
 */
export async function ensureTaskCallbackAliasStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = readDurableSession(input.sessionState);
  if (readTaskCallbackAlias(session.state) !== undefined) return input;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const alias = `${TASK_CALLBACK_ALIAS_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return {
    sessionState: replaceDurableSessionSnapshot({
      session: { ...session, state: { ...session.state, [TASK_CALLBACK_ALIAS_STATE_KEY]: alias } },
      state: input.sessionState,
    }),
  };
}

/**
 * Starts one child per agent call. Each call first commits its task record,
 * so identity is assigned before any child starts; a retried step derives
 * the same IDs, and a duplicate local start exits on its continuation claim.
 */
export async function startAgentTasksStep(input: {
  /** Calls to start; absent means the agent calls in the pending coordination batch. */
  readonly calls?: readonly AgentTaskCall[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const calls =
    input.calls ??
    (getPendingCoordinationBatch(readDurableSession(input.sessionState).state)?.tasks ?? [])
      .filter(isAgentTaskRequest)
      .map(agentTaskCallFromRequest);
  return await startAgentTasks({
    ...input,
    calls,
    callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
    now: new Date().toISOString(),
  });
}

export async function startAgentTasks(input: {
  readonly callbackBaseUrl: string;
  readonly calls: readonly AgentTaskCall[];
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const emission = getHarnessEmissionState(durableSession.state);
  // The pending batch keeps the waiting turn's ID even after a child's
  // question clears the live one, so a turn cancel still reaches these tasks.
  const turnId =
    getPendingCoordinationBatch(durableSession.state)?.event.turnId ?? activeTurnId(emission);
  const results: RuntimeToolResultActionResult[] = [];
  const replies: WorkflowCallerReply[] = [];
  const events: UnstampedMessageStreamEvent[] = [];
  const fail = (
    call: AgentTaskCall,
    action: RuntimeAgentDispatchRequest | undefined,
    output: JsonValue,
  ) => resolveFailedCall({ action, call, output, replies, results });

  const actions: { readonly call: AgentTaskCall; readonly action: RuntimeAgentDispatchRequest }[] =
    [];
  for (const call of input.calls) {
    try {
      actions.push({
        action: resolveAgentInvocationAction({ ctx, input: call.input, invocationId: call.callId }),
        call,
      });
    } catch (error) {
      fail(call, undefined, { code: SUBAGENT_EXECUTION_FAILED, message: toErrorMessage(error) });
    }
  }
  if (actions.length === 0) {
    return {
      events,
      replies,
      results,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  const freshLocalStarts = actions.filter(
    ({ action }) => action.kind === "subagent-call" && readAgentId(action) === undefined,
  ).length;
  const prepared = await prepareActionDispatch({
    batch: { event: { ...emission, turnId }, requests: actions.map(({ action }) => action) },
    ctx,
    durableSession,
    fanoutSize: Math.max(1, freshLocalStarts),
    plan: ({ bundle, ctx: planContext, session }) =>
      actions.map(({ action }) =>
        readAgentId(action) === undefined
          ? classifyFreshStart({ action, bundle, ctx: planContext, session })
          : { kind: "resume" as const, action },
      ),
    planReusesOwnerSandbox: ({ bundle, plan }) => ownerPlanReusesSandbox({ bundle, plan }),
    serializedContext: input.serializedContext,
  });

  let session = prepared.session;
  let serializedContext = input.serializedContext;
  const ownerToken = ownerInboxHookToken(session.sessionId);
  const callbackAlias = readTaskCallbackAlias(session.state);

  for (const [index, entry] of prepared.plan.entries()) {
    const { call } = actions[index]!;
    if (entry.kind === "reject") {
      fail(call, undefined, entry.result.output);
      continue;
    }
    const action = entry.kind === "start" ? entry.target.action : entry.action;
    const name = action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
    const agentId = readAgentId(action);
    let table = readTasks(session);
    const started = startTask(table, {
      agentId,
      callId: call.callId,
      kind: "agent",
      mode: "foreground",
      name,
      nodeId: action.nodeId,
      now: input.now,
      ownerId: session.sessionId,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      turnId,
      workflowCaller: call.workflowCaller,
    });
    // A replayed call already started its child and resolved its caller.
    if (started.kind === "existing") continue;
    if (started.kind === "rejected") {
      fail(call, action, { code: started.error.code, message: started.error.message });
      continue;
    }
    if (started.kind === "steered") {
      fail(call, action, {
        code: AGENT_BUSY,
        message: `Agent "${started.record.id}" is still working on an earlier call. Wait for its result before giving it more work.`,
      });
      continue;
    }
    const { record } = started;
    table = started.table;
    session = setTaskTable(session, table);

    const tracing = prepareAgentInvocationTrace({
      conversation: prepared.inheritedConversation,
      invocation: action,
      // A `ctx.agent` call nests under the workflow tool call whose run made it.
      ownerId: call.workflowCaller?.runId ?? session.sessionId,
      serializedContext,
      sessionId: session.sessionId,
      sessionState: session.state,
      startTimeMs: Date.parse(input.now),
      turnId,
    });
    serializedContext = tracing.serializedContext;

    const isRemote = action.kind === "remote-agent-call";
    if (isRemote && callbackAlias === undefined) {
      throw new Error("Remote agent tasks require the owner's callback alias.");
    }
    const replyToken = isRemote ? sessionInboxHookToken(callbackAlias!) : ownerToken;

    let child: ChildAddress | undefined;
    let failure: JsonValue | undefined;
    if (entry.kind === "resume") {
      if (record.child === undefined) {
        failure = {
          code: AGENT_UNREACHABLE,
          message: `Agent "${record.id}" can no longer be given more work. Omit agentId to start a new agent.`,
        };
      } else {
        const delivered = await deliverToChild({
          action,
          activityObserver: prepared.activityObserver,
          auth: prepared.auth,
          bundle: createAgentContinuationBundle({
            action,
            bundle: prepared.bundle,
            dynamicRemoteAgent: readDynamicRemoteAgent({ action, bundle: prepared.bundle, ctx }),
          }),
          child: record.child,
          record,
          replyToken,
        });
        if (delivered === undefined) child = record.child;
        else failure = delivered;
      }
    } else {
      const outcome = await startSubagent({
        activityObserver: prepared.activityObserver,
        auth: prepared.auth,
        batchEvent: { sequence: emission.sequence, turnId },
        bundle: prepared.bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        capabilities: prepared.capabilities,
        channelMetadata: prepared.channelMetadata,
        fanoutSize: prepared.fanoutSize,
        inheritedConversation: prepared.inheritedConversation,
        initiatorAuth: prepared.initiatorAuth,
        localDevRequest: prepared.localDevRequest,
        parentContinuationToken: replyToken,
        sandboxSessionId: prepared.sandboxSessionId,
        session,
        target: entry.target,
        taskId: record.id,
        trace: tracing.dispatch,
      });
      if (outcome.kind === "error") failure = outcome.result.output;
      else if (outcome.remote !== undefined) child = { kind: "remote", ...outcome.remote };
    }

    if (failure !== undefined) {
      const settled = applyTaskMessage(
        table,
        {
          generation: record.generation,
          kind: "task.settled",
          outcome: { error: toTaskError(failure), status: "failed" },
          taskId: record.id,
        },
        input.now,
      );
      // The failure is the call's result right now, so it is already delivered.
      session = setTaskTable(
        session,
        markTaskDelivered(settled.table, record.id, record.generation),
      );
      events.push(...settledEvents(settled.effects));
      serializedContext = await flushAgentInvocationTraces(
        tracing.fail(createFailedResult(action, call.callId, failure)),
      );
      fail(call, action, failure);
      continue;
    }
    if (child !== undefined) {
      const adopted = adoptChild(readTasks(session), record, child, input.now);
      session = setTaskTable(session, adopted.table);
      await runCommands(adopted.commands, ctx);
      events.push(
        taskStartedEvent({
          child,
          ownerSessionId: session.sessionId,
          record: findTask(adopted.table, record.id)!,
        }),
      );
    }
  }

  return {
    events,
    replies,
    results,
    serializedContext,
    sessionState: replaceDurableSessionSnapshot({
      session: projectToDurableSession(session),
      state: input.sessionState,
    }),
  };
}

/**
 * Applies one report from a child to the owner's task table: a local child's
 * `task.started`, or settled results from local and remote children. Reports
 * that match no working task are dropped, so a duplicate, stale, or
 * cancelled child never reaches the model.
 */
export async function applyTaskReportStep(input: {
  readonly payload: RuntimeActionResultHookPayload | TaskStartedHookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  return await applyTaskReport({ ...input, now: new Date().toISOString() });
}

export async function applyTaskReport(input: {
  readonly now: string;
  readonly payload: RuntimeActionResultHookPayload | TaskStartedHookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  let session = readDurableSession(input.sessionState);
  let serializedContext = input.serializedContext;
  const events: UnstampedMessageStreamEvent[] = [];
  const results: RuntimeToolResultActionResult[] = [];
  const replies: WorkflowCallerReply[] = [];
  const unchanged = session;

  if (input.payload.kind === "task.started") {
    // A cancelled task still adopts its child, so the held cancel reaches it.
    const startedCallId = input.payload.callId;
    const record = readTasks(session).records.find(
      (candidate) => candidate.callId === startedCallId && candidate.child === undefined,
    );
    if (record !== undefined) {
      const child: ChildAddress = { kind: "local", ...input.payload.child };
      const adopted = adoptChild(readTasks(session), record, child, input.now);
      session = setTaskTable(session, adopted.table);
      if (adopted.commands.length > 0) {
        await runCommands(adopted.commands, await readContext(input.serializedContext));
      }
      const current = findTask(adopted.table, record.id)!;
      // A task cancelled before its child started already reported `task.settled`.
      if (!isTerminalTaskStatus(current.status)) {
        events.push(
          taskStartedEvent({ child, ownerSessionId: session.sessionId, record: current }),
        );
      }
    }
  } else {
    const source = input.payload.source;
    for (const result of input.payload.results) {
      if (result.kind !== "subagent-result" || result.origin !== "child") continue;
      const table = readTasks(session);
      const record = findReportedTask(table, result, source);
      if (record === undefined) continue;
      const outcome = toTaskOutcome(result);
      const childEnded = result.outcome.kind === "terminal";
      const applied = applyTaskMessage(
        table,
        {
          childEnded,
          generation: record.generation,
          kind: "task.settled",
          outcome,
          taskId: record.id,
          usage: result.outcome.usageDelta,
        },
        input.now,
      );
      if (applied.effects.some((effect) => effect.kind === "confirmed")) {
        // A cancelled child confirmed it stopped: count its spend, report nothing.
        const confirmed =
          childEnded && record.child?.kind === "local"
            ? clearProxyInputRequestsForChild(
                setTaskTable(session, applied.table),
                record.child.continuationToken,
              )
            : setTaskTable(session, applied.table);
        session = setTurnUsageState(
          confirmed,
          accumulateSessionUsage({
            previous: getTurnUsageState(session.state),
            usage: result.outcome.usageDelta,
          }),
        );
        serializedContext = await flushAgentInvocationTraces(
          settleAgentInvocationTrace({
            acceptedAtMs: Date.parse(input.now),
            result,
            serializedContext,
            sessionId: session.sessionId,
          }),
        );
        continue;
      }
      const settled = settledEvents(applied.effects);
      if (settled.length === 0) continue;
      events.push(...settled);
      let next = setTaskTable(
        session,
        markTaskDelivered(applied.table, record.id, record.generation),
      );
      if (childEnded && record.child?.kind === "local") {
        next = clearProxyInputRequestsForChild(next, record.child.continuationToken);
      }
      session = setTurnUsageState(
        next,
        accumulateSessionUsage({
          previous: getTurnUsageState(next.state),
          usage: result.outcome.usageDelta,
        }),
      );
      serializedContext = await flushAgentInvocationTraces(
        settleAgentInvocationTrace({
          acceptedAtMs: Date.parse(input.now),
          result,
          serializedContext,
          sessionId: session.sessionId,
        }),
      );
      if (record.workflowCaller !== undefined) {
        replies.push({ replyTo: record.workflowCaller.replyTo, result });
      } else {
        results.push(toToolResult(record, result, outcome));
      }
    }
  }

  return {
    events,
    replies,
    results,
    serializedContext,
    sessionState:
      session === unchanged
        ? input.sessionState
        : replaceDurableSessionSnapshot({
            session,
            state: input.sessionState,
          }),
  };
}

/** Which working tasks {@link cancelTasksStep} cancels. */
export type TaskCancelSelector =
  /** The turn the session is running or parked in. */
  { readonly kind: "active-turn" } | { readonly kind: "workflow-run"; readonly runId: string };

/**
 * Records cancellation for every working task the selector picks, reports
 * each as settled, and asks each started child to stop. It never waits for
 * the child to confirm, and the confirmation reports nothing.
 */
export async function cancelTasksStep(input: {
  readonly selector: TaskCancelSelector;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const initial = readTasks(durable);
  let table = initial;
  const now = new Date().toISOString();
  const commands: CommandEffect[] = [];
  const events: UnstampedMessageStreamEvent[] = [];
  const turnId =
    getPendingCoordinationBatch(durable.state)?.event.turnId ??
    activeTurnId(input.sessionState.emissionState);
  for (const record of initial.records) {
    const selected =
      input.selector.kind === "active-turn"
        ? record.turnId === turnId
        : record.workflowCaller?.runId === input.selector.runId;
    if (!selected || isTerminalTaskStatus(record.status)) continue;
    const cancelled = cancelTask(table, record.id, now);
    table = cancelled.table;
    commands.push(...commandEffects(cancelled.effects));
    events.push(taskSettledEvent({ outcome: { status: "cancelled" }, record }));
  }
  const update = { events, replies: [], results: [], serializedContext: input.serializedContext };
  if (table === initial) return { ...update, sessionState: input.sessionState };
  await runCommands(commands, await readContext(input.serializedContext));
  return {
    ...update,
    sessionState: replaceDurableSessionSnapshot({
      session: setTaskTable(durable, table),
      state: input.sessionState,
    }),
  };
}

function adoptChild(
  table: TaskTable,
  record: TaskRecord,
  child: ChildAddress,
  now: string,
): { readonly table: TaskTable; readonly commands: readonly CommandEffect[] } {
  const applied = applyTaskMessage(
    table,
    { child, generation: record.generation, kind: "task.started", taskId: record.id },
    now,
  );
  return { commands: commandEffects(applied.effects), table: applied.table };
}

function commandEffects(effects: readonly TaskEffect[]): CommandEffect[] {
  return effects.filter((effect): effect is CommandEffect => effect.kind === "send");
}

async function readContext(
  serializedContext: Record<string, unknown>,
): Promise<ContextContainer | undefined> {
  try {
    return await deserializeContext(serializedContext);
  } catch {
    return undefined;
  }
}

function readDynamicRemoteAgent(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: Awaited<ReturnType<typeof deserializeContext>>;
}) {
  if (input.action.kind !== "remote-agent-call") return undefined;
  if (input.bundle.subagentRegistry.dynamicNodeIds?.has(input.action.nodeId) !== true)
    return undefined;
  const selection = getDynamicSubagentSelection(input.ctx, input.action.nodeId);
  return selection?.kind === "remote" ? selection.remoteAgent : undefined;
}

function readAgentId(action: RuntimeAgentDispatchRequest): string | undefined {
  const value = action.input.agentId;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Reads the task table and logs records that could not be decoded. */
export function readTasks(session: Pick<HarnessSession, "state">): TaskTable {
  const { lost, table } = readTaskTable(session.state);
  for (const task of lost) {
    log.warn("dropped an unreadable task record", {
      reason: task.reason,
      taskId: task.id,
      taskName: task.name,
    });
  }
  return table;
}

/**
 * The task a child's result settles: the current generation's call, from a
 * child of the matching kind. A cancelled task still accepts its child's
 * confirmation. Remote results must come from the remote session the owner
 * started, so one remote child cannot settle another task.
 */
function findReportedTask(
  table: TaskTable,
  result: RuntimeSubagentChildResult,
  source: RuntimeActionResultHookPayload["source"],
): TaskRecord | undefined {
  return table.records.find((record) => {
    if (record.callId !== result.callId || record.name !== result.subagentName) return false;
    if (
      record.status !== "working" &&
      record.status !== "input_required" &&
      record.cancelConfirmBy === undefined
    ) {
      return false;
    }
    if (source?.kind === "remote") {
      return (
        record.child?.kind === "remote" &&
        (source.sessionId === undefined || source.sessionId === record.child.sessionId)
      );
    }
    return record.child?.kind !== "remote";
  });
}

function resolveFailedCall(input: {
  readonly action: RuntimeAgentDispatchRequest | undefined;
  readonly call: AgentTaskCall;
  readonly output: JsonValue;
  readonly replies: WorkflowCallerReply[];
  readonly results: RuntimeToolResultActionResult[];
}): void {
  const { call } = input;
  if (call.workflowCaller !== undefined) {
    input.replies.push({
      replyTo: call.workflowCaller.replyTo,
      result: {
        callId: call.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: input.output,
        subagentName: call.input.target,
      },
    });
    return;
  }
  input.results.push({
    callId: call.callId,
    isError: true,
    kind: "tool-result",
    output: input.output,
    toolName: call.toolName ?? call.input.target,
  });
}
