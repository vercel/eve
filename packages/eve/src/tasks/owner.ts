import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload, TaskStartedHookPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { projectToDurableSession } from "#execution/session.js";
import type { InternalAgentInput } from "#execution/tools/workflow/agent.js";
import {
  classifyFreshStart,
  createAgentContinuationBundle,
  ownerPlanReusesSandbox,
  resolveAgentInvocationAction,
  startSubagent,
} from "#tasks/start.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import {
  accumulateSessionUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { taskEvents } from "#tasks/events.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeSubagentResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { toErrorMessage } from "#shared/errors.js";
import { EXECUTION_FAILED } from "#subagents/agent-handle-errors.js";
import { renderUnknownSendTask } from "#tasks/render.js";
import { sendReceiptResult, startReceiptResult, tooManyTasksResult } from "#tasks/receipts.js";
import { deliverSend, flushHeldCommands, retireIdleTaskChildren } from "#tasks/send.js";
import { resolveAgentTaskTimeout } from "#tasks/timeout.js";
import { prepareAgentInvocationTrace } from "#tracing/agent-invocation-coordinator.js";
import {
  flushAgentInvocationTraces,
  settleAgentInvocationTrace,
} from "#tracing/agent-invocation-terminal.js";
import { coordinationTurnId, getPendingCoordinationBatch } from "#harness/coordination.js";
import { agentTaskCallFromRequest, isAgentTaskRequest } from "#tasks/agent-tool.js";
import {
  reportedAnswer,
  reportedSteers,
  type ChildAddress,
  type TaskError,
} from "#tasks/protocol.js";
import {
  createFailedResult,
  failEmptyResult,
  toTaskError,
  toTaskOutcome,
  toToolResult,
} from "#tasks/outcome.js";
import {
  cancelOrphanedChild,
  deliverToChild,
  runCommands,
  type CommandEffect,
} from "#tasks/transport.js";
import {
  checkSend,
  findReportedTask,
  readDynamicRemoteAgent,
  readSendTaskId,
  resolveFailedCall,
} from "#tasks/owner-calls.js";
import {
  getTaskTable,
  ownerInboxHookToken,
  readTaskCallbackAlias,
  setTaskTable,
  TASK_CALLBACK_ALIAS_PREFIX,
  TASK_CALLBACK_ALIAS_STATE_KEY,
} from "#tasks/state.js";
import type { TaskRecord } from "#tasks/record.js";
import { encodeTaskCreator } from "#tasks/results.js";
import {
  applyTaskMessage,
  markTaskDelivered,
  startTask,
  type TaskEffect,
  type TaskTable,
  type TaskTransition,
} from "#tasks/table.js";
import { sendTask } from "#tasks/table-generations.js";
import { syncTaskTimerInStep } from "#tasks/timer-steps.js";
import { routeDetachedResult } from "#tasks/wait.js";

/** One agent call: from the model, or from `ctx.agent` inside a workflow tool body. */
export interface AgentTaskCall {
  readonly callId: string;
  readonly input: InternalAgentInput;
  readonly toolName?: string;
  /** Set for `ctx.agent`: the workflow body awaits the result. A model's call is detached. */
  readonly workflowCaller?: TaskRecord["workflowCaller"];
}

/** A result owed to a `ctx.agent` caller. */
export interface WorkflowCallerReply {
  readonly replyTo: string;
  readonly result: RuntimeSubagentResult;
}

/** What the session body does after an owner step: publish events and resolve callers. */
export interface TaskOwnerUpdate {
  /** `task.*` lifecycle events, in the order the task table's transitions produced them. */
  readonly events: readonly UnstampedMessageStreamEvent[];
  /** Tool results for waited model calls. */
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly replies: readonly WorkflowCallerReply[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** What starting agent calls returns: the owner update, or a request to claim the new callback alias first. */
export type StartAgentTasksUpdate = TaskOwnerUpdate & {
  /**
   * Set when the calls include a remote agent and the owner had no callback
   * alias: the step minted one into `sessionState` and started nothing. The
   * owner claims the alias and runs the step again, so the alias is claimed
   * before a remote child could call back on it.
   */
  readonly callbackAliasMinted?: true;
};

/**
 * Starts one child per agent call. Each call first commits its task record,
 * so identity is assigned before any child starts; a retried step derives
 * the same IDs, and a duplicate local start exits on its continuation claim.
 */
export async function startAgentTasksStep(input: {
  /** Calls to start; absent means the agent calls in the pending coordination batch. */
  readonly calls?: readonly AgentTaskCall[] | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<StartAgentTasksUpdate> {
  "use step";

  const calls =
    input.calls ??
    (getPendingCoordinationBatch(readDurableSession(input.sessionState).state)?.tasks ?? [])
      .filter(isAgentTaskRequest)
      .map(agentTaskCallFromRequest);
  const update = await startAgentTasks({
    ...input,
    calls,
    callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
    now: new Date().toISOString(),
  });
  // Arms the new calls' deadline after their children started, off their path.
  return { ...update, sessionState: await syncTaskTimerInStep(update.sessionState) };
}

export async function startAgentTasks(input: {
  readonly callbackBaseUrl: string;
  readonly calls: readonly AgentTaskCall[];
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<StartAgentTasksUpdate> {
  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const emission = getHarnessEmissionState(durableSession.state);
  // A turn cancel still reaches these tasks after a child's question clears the live turn.
  const turnId = coordinationTurnId(durableSession.state, emission);
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
      fail(call, undefined, { code: EXECUTION_FAILED, message: toErrorMessage(error) });
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
  // Only remote children call back on the alias, so a session that never
  // calls a remote agent never mints one.
  if (
    readTaskCallbackAlias(durableSession.state) === undefined &&
    actions.some(({ action }) => action.kind === "remote-agent-call")
  ) {
    return {
      callbackAliasMinted: true,
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: replaceDurableSessionSnapshot({
        session: {
          ...durableSession,
          state: { ...durableSession.state, [TASK_CALLBACK_ALIAS_STATE_KEY]: mintCallbackAlias() },
        },
        state: input.sessionState,
      }),
    };
  }

  const freshLocalStarts = actions.filter(
    ({ action }) => action.kind === "subagent-call" && readSendTaskId(action) === undefined,
  ).length;
  const prepared = await prepareActionDispatch({
    batch: { event: { ...emission, turnId }, requests: actions.map(({ action }) => action) },
    ctx,
    durableSession,
    fanoutSize: Math.max(1, freshLocalStarts),
    plan: ({ bundle, ctx: planContext, session }) =>
      actions.map(({ action }) =>
        readSendTaskId(action) === undefined
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
    const taskId = readSendTaskId(action);
    const toolName = call.toolName ?? call.input.target;
    const detached = call.workflowCaller === undefined;
    const mode = detached ? ("detached" as const) : ("attached" as const);
    const timeoutMs = resolveAgentTaskTimeout({ action, bundle: prepared.bundle, ctx });
    let table = getTaskTable(session);
    let record: TaskRecord;
    if (taskId === undefined) {
      const started = startTask(table, {
        callId: call.callId,
        creator: encodeTaskCreator(prepared.creator),
        kind: "agent",
        mode,
        name,
        nodeId: action.nodeId,
        now: input.now,
        ownerId: session.sessionId,
        resumable: true,
        timeoutMs,
        turnId,
        workflowCaller: call.workflowCaller,
      });
      if (started.kind === "existing") {
        // A replayed call already started its child; a detached call still owes its receipt.
        if (started.record.mode === "detached" && detached) {
          results.push(startReceiptResult(started.record, toolName));
        }
        continue;
      }
      // Over the cap, the start commits nothing.
      const rejected = detached
        ? tooManyTasksResult({ callId: call.callId, table, toolName })
        : undefined;
      if (rejected !== undefined) {
        results.push(rejected);
        continue;
      }
      ({ record, table } = started);
    } else {
      const refused = checkSend({
        caller: prepared.auth,
        fromWorkflow: !detached,
        nodeId: action.nodeId,
        table,
        taskId,
        toolName: name,
      });
      const sent =
        refused === undefined
          ? sendTask(table, {
              callId: call.callId,
              input: agentSendInput(action),
              mode,
              now: input.now,
              taskId,
              timeoutMs,
              turnId,
              workflowCaller: call.workflowCaller,
            })
          : undefined;
      if (sent === undefined) {
        fail(call, action, { ...(refused ?? unknownSend(taskId, name)) });
        continue;
      }
      const receipt = (started: boolean) =>
        detached &&
        results.push(
          sendReceiptResult({ callId: call.callId, record: sent.record, started, toolName }),
        );
      // A replayed send already reached the agent; a detached call still owes its receipt.
      if (sent.kind === "existing") {
        if (sent.record.mode === "detached") receipt(sent.record.callId === call.callId);
        continue;
      }
      if (!sent.started) {
        // A working agent takes the input now; one still starting gets it once it reports.
        const delivered = await deliverSend({ callbackAlias, ctx, now: input.now, sent, session });
        ({ session } = delivered);
        events.push(...delivered.events);
        results.push(...delivered.results);
        if (delivered.failure === undefined) receipt(false);
        else fail(call, action, delivered.failure.output);
        continue;
      }
      // The idle agent's next generation starts now; its turn is delivered below.
      events.push(...taskEvents(sent.effects, session.sessionId));
      ({ record, table } = sent);
    }
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
    // A child that never started, or cannot take a send for good, ends the task.
    let childEnded = entry.kind === "start" ? (true as const) : undefined;
    if (entry.kind === "resume") {
      if (record.child !== undefined) {
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
        if (delivered !== undefined) {
          failure = delivered.output;
          if (delivered.permanent) childEnded = true;
        }
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
          childEnded,
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
      events.push(...taskEvents(settled.effects, session.sessionId));
      serializedContext = await flushAgentInvocationTraces(
        tracing.fail(createFailedResult(action, call.callId, failure)),
      );
      fail(call, action, failure);
      continue;
    }
    // A remote child's address is known now; a local child reports its own.
    if (child !== undefined) {
      const adopted = adoptChild(getTaskTable(session), record, child, input.now);
      session = setTaskTable(
        session,
        await flushHeldCommands({
          callbackAlias,
          ctx,
          effects: adopted.commands,
          ownerSessionId: session.sessionId,
          table: adopted.table,
        }),
      );
      events.push(...taskEvents(adopted.effects, session.sessionId));
    }
    if (!detached) continue;
    results.push(
      taskId === undefined
        ? startReceiptResult(record, toolName)
        : sendReceiptResult({ callId: call.callId, record, started: true, toolName }),
    );
  }

  const retired = await retireIdleTaskChildren({
    caller: prepared.auth,
    ctx,
    now: input.now,
    session,
  });
  ({ session } = retired);
  events.push(...retired.events);

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

  const update = await applyTaskReport({ ...input, now: new Date().toISOString() });
  return { ...update, sessionState: await syncTaskTimerInStep(update.sessionState) };
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
    const { callId: startedCallId, child: reported } = input.payload;
    const tasks = getTaskTable(session);
    const record = tasks.records.find(
      (candidate) =>
        candidate.callId === startedCallId &&
        candidate.child === undefined &&
        candidate.ended !== true,
    );
    const duplicate = tasks.records.some(
      (candidate) =>
        candidate.child?.kind === "local" && candidate.child.sessionId === reported.sessionId,
    );
    if (record === undefined && !duplicate) {
      // The task ended before its child reported, so the held cancel is
      // gone; the child must not run unsupervised.
      await cancelOrphanedChild({ callId: startedCallId, sessionId: reported.sessionId });
    }
    if (record !== undefined) {
      const child: ChildAddress = { kind: "local", ...input.payload.child };
      const adopted = adoptChild(getTaskTable(session), record, child, input.now);
      const flushed =
        adopted.commands.length === 0
          ? adopted.table
          : await flushHeldCommands({
              callbackAlias: readTaskCallbackAlias(session.state),
              ctx: await readContext(input.serializedContext),
              effects: adopted.commands,
              ownerSessionId: session.sessionId,
              table: adopted.table,
            });
      session = setTaskTable(session, flushed);
      events.push(...taskEvents(adopted.effects, session.sessionId));
    }
  } else {
    const source = input.payload.source;
    for (const reported of input.payload.results) {
      if (reported.kind !== "subagent-result" || reported.origin !== "child") continue;
      const result = failEmptyResult(reported);
      const table = getTaskTable(session);
      const record = findReportedTask(table, result, source);
      if (record === undefined) continue;
      const outcome = toTaskOutcome(result);
      const childEnded = result.outcome.kind === "terminal";
      const applied = applyTaskMessage(
        table,
        {
          answer: reportedAnswer(result),
          childEnded,
          generation: record.generation,
          kind: "task.settled",
          outcome,
          steers: reportedSteers(result),
          taskId: record.id,
          usage: result.outcome.usageDelta,
        },
        input.now,
      );
      if (applied.effects.length === 0) continue;
      // The report's own generation settled; a cancelled child only confirmed it stopped.
      const settled = applied.effects.some(
        (effect) => effect.kind === "settled" && effect.record.generation === record.generation,
      );
      events.push(...taskEvents(applied.effects, session.sessionId));
      // An awaited call's result is delivered now; a detached one goes to a
      // live `task_wait`, or is held for delivery. So does each generation the
      // report started, such as one for a send the agent read too late.
      const detached = record.mode === "detached" && record.workflowCaller === undefined;
      let next = setTaskTable(
        session,
        settled && !detached
          ? markTaskDelivered(applied.table, record.id, record.generation)
          : applied.table,
      );
      for (const effect of applied.effects) {
        if (effect.kind !== "settled") continue;
        if (!detached && effect.record.generation === record.generation) continue;
        const routed = routeDetachedResult(next, effect.record, effect.outcome);
        next = routed.session;
        if (routed.result !== undefined) results.push(routed.result);
      }
      const stops = commandEffects(applied.effects);
      if (stops.length > 0) await runCommands(stops, await readContext(input.serializedContext));
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
      if (!settled) continue;
      if (record.workflowCaller !== undefined) {
        replies.push({ replyTo: record.workflowCaller.replyTo, result });
      } else if (!detached) {
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

/** Records a child's address, announcing its generation, and returns the commands held for it. */
function adoptChild(
  table: TaskTable,
  record: TaskRecord,
  child: ChildAddress,
  now: string,
): TaskTransition & { readonly commands: readonly CommandEffect[] } {
  const applied = applyTaskMessage(
    table,
    { child, generation: record.generation, kind: "task.started", taskId: record.id },
    now,
  );
  return { ...applied, commands: commandEffects(applied.effects) };
}

/** A send's input for an agent: its message, and the output schema its reply must match. */
function agentSendInput(action: RuntimeAgentDispatchRequest): JsonObject {
  const { message, outputSchema } = action.input;
  const input: JsonObject = { message: message ?? "" };
  return outputSchema === undefined ? input : { ...input, outputSchema };
}

function unknownSend(taskId: string, name: string): TaskError {
  return { code: "UNKNOWN_TASK", message: renderUnknownSendTask(taskId, name) };
}

/** An unguessable alias: remote children present it as their callback token. */
function mintCallbackAlias(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${TASK_CALLBACK_ALIAS_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function commandEffects(effects: readonly TaskEffect[]): CommandEffect[] {
  return effects.filter((effect): effect is CommandEffect => effect.kind === "send");
}

export async function readContext(
  serializedContext: Record<string, unknown>,
): Promise<ContextContainer | undefined> {
  try {
    return await deserializeContext(serializedContext);
  } catch {
    return undefined;
  }
}
