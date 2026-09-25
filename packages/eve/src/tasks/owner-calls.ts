import type { RuntimeActionResultHookPayload, SessionAuthContext } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeSubagentChildResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { AgentTaskCall, WorkflowCallerReply } from "#tasks/owner.js";
import { childCallId, isIdleTask, isOpenResumableTask, type TaskRecord } from "#tasks/record.js";
import {
  renderTaskBusy,
  renderTaskMismatch,
  renderTaskOtherPrincipal,
  renderTooManyTasks,
  renderTooManyUnreadSends,
  renderUnknownSendTask,
  renderUnknownTask,
} from "#tasks/render.js";
import { MAX_TASK_ID_LENGTH } from "#tasks/ids.js";
import { isTaskOf } from "#tasks/results.js";
import { isTerminalTaskStatus, type TaskError } from "#tasks/protocol.js";
import {
  findTask,
  MAX_UNREAD_SENDS,
  MAX_WORKING_TASKS,
  workingDetachedTaskIds,
  type TaskEffect,
  type TaskTable,
  type TaskTransition,
} from "#tasks/table.js";
import { endTask } from "#tasks/table-generations.js";

// How the owner resolves one task call: sends, lookups, idle retirement, and
// the child report that settles an agent call.

/**
 * Idle tasks a session keeps: agents and resumable workflow tools. Each keeps
 * a child the model may give more work. Each time the owner starts tasks, it
 * ends the idle tasks past this many, least recently started first, so a long
 * session's records and children stay bounded. The `[Tasks]` note lists only
 * the 10 most recent.
 */
export const MAX_RETAINED_IDLE_TASKS = 50;

/**
 * Ends idle tasks past {@link MAX_RETAINED_IDLE_TASKS}, least recently
 * started first. The calling principal's own idle tasks go before anyone
 * else's, so in a shared session one caller's new tasks end another caller's
 * tasks only once the first has none idle. Each retired task ends like any
 * other, so its record is pruned; `retired` keeps each one's child for the
 * owner to end. A later send to it fails `UNKNOWN_TASK`.
 */
export function retireIdleTasks(
  table: TaskTable,
  caller: SessionAuthContext | null,
  now: string,
): TaskTransition & { readonly retired: readonly TaskRecord[] } {
  const idle = table.records.filter(isIdleTask);
  const excess = idle.length - MAX_RETAINED_IDLE_TASKS;
  if (excess <= 0) return { effects: [], retired: [], table };
  const others = (record: TaskRecord) => (isTaskOf(record, caller) ? 0 : 1);
  const retired = idle
    .toSorted(
      (left, right) =>
        others(left) - others(right) || Date.parse(left.startedAt) - Date.parse(right.startedAt),
    )
    .slice(0, excess);
  let next = table;
  const effects: TaskEffect[] = [];
  for (const record of retired) {
    const ended = endTask(next, record, now);
    next = ended.table;
    effects.push(...ended.effects);
  }
  return { effects, retired, table: next };
}

/**
 * Checks a send, a call to a resumable tool with a task's `taskId`, before
 * the owner records it. A task only takes input as its own tool's input,
 * from the principal that started it: it acts with its starter's credentials
 * and keeps their conversation. Every unauthenticated caller is the same
 * anonymous principal, so this separates no two of them. A workflow body
 * awaits the result of the work it started, so a generation a body awaits
 * takes no send, and a body's send never joins work it did not start. A task
 * holds at most {@link MAX_UNREAD_SENDS} sends it has not read and that no
 * cancel stopped, and takes none after one its agent may not have received
 * (see `markSendUnconfirmed`). A send that starts an idle task's next
 * generation counts toward the working-task cap like any start. The
 * principal is checked first, so another caller learns nothing about the
 * task, not even its tool.
 */
export function checkSend(input: {
  readonly caller: SessionAuthContext | null;
  /** The send comes from a workflow body (`ctx.agent`). */
  readonly fromWorkflow?: boolean;
  /** The agent definition the tool targets; a dynamic agent's changes with its selection. */
  readonly nodeId?: string;
  readonly table: TaskTable;
  readonly taskId: string;
  readonly toolName: string;
}): TaskError | undefined {
  const { taskId, toolName } = input;
  const record = findTask(input.table, taskId);
  // A task whose child never started cannot take input; one still starting holds it.
  if (
    record === undefined ||
    !isOpenResumableTask(record) ||
    (record.child === undefined && isTerminalTaskStatus(record.status))
  ) {
    return unknownSend(taskId, toolName);
  }
  if (!isTaskOf(record, input.caller)) {
    return { code: "TASK_OTHER_PRINCIPAL", message: renderTaskOtherPrincipal(record.id) };
  }
  if (
    record.name !== toolName ||
    (input.nodeId !== undefined && record.nodeId !== undefined && record.nodeId !== input.nodeId)
  ) {
    return { code: "TASK_MISMATCH", message: renderTaskMismatch(record) };
  }
  const working = !isTerminalTaskStatus(record.status);
  if (working && record.workflowCaller !== undefined) {
    return { code: "TASK_BUSY", message: renderTaskBusy(record.id, toolName, "workflow-owned") };
  }
  if (working && input.fromWorkflow === true) {
    return { code: "TASK_BUSY", message: renderTaskBusy(record.id, toolName, "workflow-caller") };
  }
  if (record.sends?.some((send) => send.unconfirmed === true) === true) {
    return { code: "TASK_BUSY", message: renderTaskBusy(record.id, toolName, "unconfirmed") };
  }
  // An agent keeps the send it is working on listed until it answers.
  const unread = record.sends?.filter(
    (send) => send.cancelled !== true && send.seq !== record.startedBy,
  );
  if ((unread?.length ?? 0) >= MAX_UNREAD_SENDS) {
    return {
      code: "TASK_BUSY",
      message: renderTooManyUnreadSends(record.id, toolName, MAX_UNREAD_SENDS),
    };
  }
  if (working || input.fromWorkflow === true) return undefined;
  return tooManyTasks(input.table, input.caller);
}

/**
 * `TOO_MANY_TASKS` for a start while the session's working detached tasks
 * fill the cap. Every principal's tasks count, but the message names only
 * the caller's, the only ones it can wait on or cancel.
 */
export function tooManyTasks(
  table: TaskTable,
  caller: SessionAuthContext | null,
): TaskError | undefined {
  const working = new Set(workingDetachedTaskIds(table));
  if (working.size < MAX_WORKING_TASKS) return undefined;
  const own = table.records.flatMap((record) =>
    working.has(record.id) && isTaskOf(record, caller) ? [record.id] : [],
  );
  return { code: "TOO_MANY_TASKS", message: renderTooManyTasks(own, MAX_WORKING_TASKS) };
}

/**
 * The task a `task_wait` or `task_cancel` call names, or the call's error. A
 * task the session does not have, an attached call its turn still holds, and
 * a `ctx.agent` call a workflow body still awaits are unknown to the model;
 * once finished, such an agent is idle like any other and the `[Tasks]` note
 * lists it. A task a different principal started is refused, as for agent
 * calls.
 */
export function findCallerTask(input: {
  readonly caller: SessionAuthContext | null;
  readonly table: TaskTable;
  readonly taskId: string;
}): { readonly record: TaskRecord } | { readonly error: TaskError } {
  const record = findTask(input.table, input.taskId);
  if (
    record === undefined ||
    ((record.workflowCaller !== undefined || record.mode === "attached") &&
      !isTerminalTaskStatus(record.status))
  ) {
    return { error: { code: "UNKNOWN_TASK", message: renderUnknownTask(input.taskId) } };
  }
  if (!isTaskOf(record, input.caller)) {
    return {
      error: { code: "TASK_OTHER_PRINCIPAL", message: renderTaskOtherPrincipal(record.id) },
    };
  }
  return { record };
}

export function readDynamicRemoteAgent(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextContainer;
}) {
  if (input.action.kind !== "remote-agent-call") return undefined;
  if (input.bundle.subagentRegistry.dynamicNodeIds?.has(input.action.nodeId) !== true)
    return undefined;
  const selection = getDynamicSubagentSelection(input.ctx, input.action.nodeId);
  return selection?.kind === "remote" ? selection.remoteAgent : undefined;
}

/**
 * The error of a send to a task the session does not have open. A
 * `ctx.agent` call's `taskId` has no schema bound, so the echo gets one.
 */
export function unknownSend(taskId: string, toolName: string): TaskError {
  const echoed = taskId.slice(0, MAX_TASK_ID_LENGTH);
  return { code: "UNKNOWN_TASK", message: renderUnknownSendTask(echoed, toolName) };
}

/** A send's input for an agent: its message, and the output schema its reply must match. */
export function agentSendInput(action: RuntimeAgentDispatchRequest): JsonObject {
  const { message, outputSchema } = action.input;
  const input: JsonObject = { message: message ?? "" };
  return outputSchema === undefined ? input : { ...input, outputSchema };
}

/** The `taskId` of an agent call that sends to an existing agent. */
export function readSendTaskId(action: RuntimeAgentDispatchRequest): string | undefined {
  const value = action.input.taskId;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The task a child's result settles: the call the child answers for the
 * current generation, from a child of the matching kind. A cancelled task
 * still accepts its child's confirmation. Remote results must come from the remote session the owner
 * started, so one remote child cannot settle another task.
 */
export function findReportedTask(
  table: TaskTable,
  result: RuntimeSubagentChildResult,
  source: RuntimeActionResultHookPayload["source"],
): TaskRecord | undefined {
  return table.records.find((record) => {
    if (childCallId(record) !== result.callId || record.name !== result.subagentName) return false;
    if (
      record.status !== "working" &&
      record.status !== "input_required" &&
      record.cancelConfirmBy === undefined
    ) {
      return false;
    }
    if (source?.kind === "remote") {
      return record.child?.kind === "remote" && source.sessionId === record.child.sessionId;
    }
    return record.child?.kind !== "remote";
  });
}

export function resolveFailedCall(input: {
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
