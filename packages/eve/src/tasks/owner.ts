import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload, TaskStartedHookPayload } from "#channel/types.js";
import { ContinuationHookTokensKey } from "#context/keys.js";
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
import { workflowEntryReference } from "#execution/workflow-runtime.js";
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
import { createSubagentCalledEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeAgentDispatchRequest,
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
import type { ChildAddress } from "#tasks/protocol.js";
import { createFailedResult, toTaskError, toTaskOutcome, toToolResult } from "#tasks/outcome.js";
import { deliverToChild, runCommands, type CommandEffect } from "#tasks/transport.js";
import { ownerInboxHookToken, setTaskTable } from "#tasks/state.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  applyTaskMessage,
  cancelTask,
  DEFAULT_AGENT_TIMEOUT_MS,
  findTask,
  readTaskTable,
  startTask,
  type TaskEffect,
  type TaskTable,
} from "#tasks/table.js";

const log = createLogger("tasks.owner");

/** Unguessable per-session alias that remote children call back on. */
const TASK_CALLBACK_ALIAS_KEY = "eve.taskCallbackAlias";

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
  readonly events: readonly UnstampedMessageStreamEvent[];
  /** Tool results for waited model calls. */
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly replies: readonly WorkflowCallerReply[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
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
  const turnId = activeTurnId(emission);
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
  let callbackAlias = readCallbackAlias(session);

  for (const [index, entry] of prepared.plan.entries()) {
    const { call } = actions[index]!;
    if (entry.kind === "reject") {
      fail(call, undefined, entry.result.output);
      continue;
    }
    const action = entry.kind === "start" ? entry.target.action : entry.action;
    const name = action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
    const agentId = readAgentId(action);
    let table = getTaskTable(session);
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
      ownerId: session.sessionId,
      serializedContext,
      sessionId: session.sessionId,
      sessionState: session.state,
      startTimeMs: Date.parse(input.now),
      turnId,
    });
    serializedContext = tracing.serializedContext;

    const isRemote = action.kind === "remote-agent-call";
    if (isRemote && callbackAlias === undefined) {
      callbackAlias = mintCallbackAlias();
      session = {
        ...session,
        state: { ...session.state, [TASK_CALLBACK_ALIAS_KEY]: callbackAlias },
      };
      serializedContext = recordContinuationHookToken(serializedContext, callbackAlias);
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
      session = setTaskTable(session, markDelivered(settled.table, record.id));
      serializedContext = await flushAgentInvocationTraces(
        tracing.fail(createFailedResult(action, call.callId, failure)),
      );
      fail(call, action, failure);
      continue;
    }
    if (child !== undefined) {
      const adopted = adoptChild(getTaskTable(session), record, child, input.now);
      session = setTaskTable(session, adopted.table);
      await runCommands(adopted.commands, prepared.bundle);
      events.push(
        createCalledEvent({
          child,
          record: findTask(adopted.table, record.id)!,
          sequence: emission.sequence,
          sessionId: session.sessionId,
          toolName: call.toolName ?? name,
          turnId,
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
  const emission = getHarnessEmissionState(session.state);

  if (input.payload.kind === "task.started") {
    // A cancelled task still adopts its child, so the held cancel reaches it.
    const startedCallId = input.payload.callId;
    const record = getTaskTable(session).records.find(
      (candidate) => candidate.callId === startedCallId && candidate.child === undefined,
    );
    if (record !== undefined) {
      const child: ChildAddress = { kind: "local", ...input.payload.child };
      const adopted = adoptChild(getTaskTable(session), record, child, input.now);
      session = setTaskTable(session, adopted.table);
      if (adopted.commands.length > 0) {
        await runCommands(adopted.commands, await readBundle(input.serializedContext));
      }
      const current = findTask(adopted.table, record.id)!;
      if (current.status === "working" || current.status === "input_required") {
        events.push(
          createCalledEvent({
            child,
            record: current,
            sequence: emission.sequence,
            sessionId: session.sessionId,
            toolName: current.name,
            turnId: current.turnId,
          }),
        );
      }
    }
  } else {
    for (const result of input.payload.results) {
      if (result.kind !== "subagent-result" || result.origin !== "child") continue;
      const table = getTaskTable(session);
      const record = findWorkingTaskByCall(table, result.callId);
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
      if (!applied.effects.some((effect) => effect.kind === "settled")) continue;
      let next = setTaskTable(session, markDelivered(applied.table, record.id));
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
      if (outcome.status === "completed") {
        events.push({
          data: {
            callId: result.callId,
            output:
              typeof result.output === "string" ? result.output : JSON.stringify(result.output),
            subagentName: record.name,
          },
          type: "subagent.completed",
        });
      }
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

/**
 * Records cancellation for every working task the predicate selects and asks
 * each started child to stop. It never waits for the child to confirm.
 */
export async function cancelTasksStep(input: {
  readonly selector:
    /** The turn the session is running or parked in. */
    { readonly kind: "active-turn" } | { readonly kind: "workflow-run"; readonly runId: string };
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const initial = getTaskTable(durable);
  let table = initial;
  const now = new Date().toISOString();
  const commands: CommandEffect[] = [];
  const turnId =
    getPendingCoordinationBatch(durable.state)?.event.turnId ??
    activeTurnId(input.sessionState.emissionState);
  for (const record of initial.records) {
    const selected =
      input.selector.kind === "active-turn"
        ? record.turnId === turnId
        : record.workflowCaller?.runId === input.selector.runId;
    if (!selected) continue;
    const cancelled = cancelTask(table, record.id, now);
    table = cancelled.table;
    commands.push(...commandEffects(cancelled.effects));
  }
  if (table === initial) return { sessionState: input.sessionState };
  await runCommands(commands, await readBundle(input.serializedContext));
  return {
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

async function readBundle(
  serializedContext: Record<string, unknown>,
): Promise<CompiledBundle | undefined> {
  try {
    return (await deserializeContext(serializedContext)).get(BundleKey);
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
function getTaskTable(session: Pick<HarnessSession, "state">): TaskTable {
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

function mintCallbackAlias(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `task-callback:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function readCallbackAlias(session: Pick<HarnessSession, "state">): string | undefined {
  const value = session.state?.[TASK_CALLBACK_ALIAS_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordContinuationHookToken(
  serializedContext: Record<string, unknown>,
  token: string,
): Record<string, unknown> {
  const recorded = serializedContext[ContinuationHookTokensKey.name];
  const tokens = Array.isArray(recorded)
    ? recorded.filter((value) => typeof value === "string")
    : [];
  return tokens.includes(token)
    ? serializedContext
    : { ...serializedContext, [ContinuationHookTokensKey.name]: [...tokens, token] };
}

function findWorkingTaskByCall(table: TaskTable, callId: string): TaskRecord | undefined {
  return table.records.find(
    (record) =>
      record.callId === callId &&
      (record.status === "working" || record.status === "input_required"),
  );
}

/** Foreground and `ctx.agent` results reach their caller in the same step they settle. */
function markDelivered(table: TaskTable, taskId: string): TaskTable {
  const record = findTask(table, taskId);
  if (record === undefined || record.delivered) return table;
  return {
    records: table.records.map((candidate) =>
      candidate === record ? { ...record, delivered: true } : candidate,
    ),
  };
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

function createCalledEvent(input: {
  readonly child: ChildAddress;
  readonly record: TaskRecord;
  readonly sequence: number;
  readonly sessionId: string;
  readonly toolName: string;
  readonly turnId: string;
}): UnstampedMessageStreamEvent {
  const { child, record } = input;
  return createSubagentCalledEvent({
    agentId: record.id,
    callId: record.callId,
    childSessionId: child.kind === "workflow" ? child.runId : child.sessionId,
    name: record.name,
    remote:
      child.kind === "remote"
        ? { resolverId: child.credentialResolver ?? record.nodeId, url: child.url }
        : undefined,
    sequence: input.sequence,
    sessionId: input.sessionId,
    toolName: input.toolName,
    turnId: input.turnId,
    workflowId: workflowEntryReference.workflowId,
  });
}
