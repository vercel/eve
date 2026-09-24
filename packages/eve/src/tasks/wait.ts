import type { SessionAuthContext } from "#channel/types.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { SessionStateMap } from "#harness/types.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import type { TaskOwnerUpdate } from "#tasks/owner.js";
import { findCallerTask } from "#tasks/owner-calls.js";
import { isTerminalTaskStatus, type TaskOutcome } from "#tasks/protocol.js";
import { taskToolErrorResult } from "#tasks/receipts.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  renderTaskAlreadyWaited,
  renderUnknownTask,
  renderWaitIdle,
  renderWaitInterrupted,
  renderWaitTimedOut,
  TASK_WAIT_INVALID_INPUT_MESSAGE,
} from "#tasks/render.js";
import { holdTaskResult, takeTaskResult } from "#tasks/results.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { markTaskDelivered, setTaskWait } from "#tasks/table.js";
import { readTaskWaitInput, type TaskWaitOutput } from "#tasks/wait-tool.js";

// Owner side of `task_wait`. A wait is the `wait` field of its task's record:
// set while the call waits, and cleared by whichever comes first, the result,
// the timeout, a steering message, or the turn's cancel. Every transition runs
// in an owner step, so each result reaches exactly one place. Read by the
// session workflow body, so this module must not import Node.js built-ins.

type Session = { readonly state?: SessionStateMap };

/** A wait the turn holds for, with its timeout when it has one. */
export interface TaskWaitRegistration {
  readonly callId: string;
  readonly timeoutMs?: number;
}

/** Why waits end without a result. A cancelled turn's waits end with no tool result. */
export type TaskWaitEnd = "timed_out" | "interrupted" | "turn-cancelled";

/** The one call waiting on a task's result. */
type WaitingCall = Pick<RuntimeWorkflowTaskRequest, "callId" | "toolName">;

/**
 * Applies one `task_wait` call. It resolves at once when the answer is known
 * now: an error, a result the model has not seen, an idle agent, or a zero
 * timeout. Otherwise it points the task at this call, and the turn holds.
 */
export function applyTaskWaitCall<T extends Session>(input: {
  readonly caller: SessionAuthContext | null;
  readonly now: string;
  readonly request: RuntimeWorkflowTaskRequest;
  readonly session: T;
}): {
  readonly session: T;
  readonly result?: RuntimeToolResultActionResult;
  readonly wait?: TaskWaitRegistration;
} {
  const { request, session } = input;
  const parsed = readTaskWaitInput(request.input);
  if (parsed === undefined) {
    const error = { code: "INVALID_INPUT", message: TASK_WAIT_INVALID_INPUT_MESSAGE };
    return { result: taskToolErrorResult(request, error), session };
  }
  const table = getTaskTable(session);
  const found = findCallerTask({ caller: input.caller, table, taskId: parsed.taskId });
  if ("error" in found) return { result: taskToolErrorResult(request, found.error), session };
  const { record } = found;
  // A result that settled before the wait began goes to the wait, not to a later message.
  const held = takeTaskResult(session, record.id, record.generation);
  if (held.result !== undefined) {
    return { result: settledResult(request, record, held.result.outcome), session: held.session };
  }
  if (isTerminalTaskStatus(record.status)) {
    if (record.kind !== "agent" || record.child === undefined) {
      const error = { code: "UNKNOWN_TASK", message: renderUnknownTask(record.id) };
      return { result: taskToolErrorResult(request, error), session };
    }
    const idle = { status: "idle", taskId: record.id } as const;
    return { result: waitResult(request, idle, renderWaitIdle(record)), session };
  }
  if (record.wait !== undefined && waitingCall(session.state, record.wait.callId) !== undefined) {
    const error = { code: "TASK_ALREADY_WAITED", message: renderTaskAlreadyWaited(record.id) };
    return { result: taskToolErrorResult(request, error), session };
  }
  if (parsed.timeoutMs === 0) {
    const timedOut = { status: "timed_out", taskId: record.id } as const;
    return { result: waitResult(request, timedOut, renderWaitTimedOut(record.id, 0)), session };
  }
  const wait = { callId: request.callId, startedAt: input.now };
  return {
    session: setTaskTable(session, setTaskWait(table, record.id, wait)),
    wait:
      parsed.timeoutMs === undefined
        ? { callId: request.callId }
        : { callId: request.callId, timeoutMs: parsed.timeoutMs },
  };
}

/**
 * Sends a detached task's settled result to its one place: the live
 * `task_wait` on the task, as that call's tool result, or else the held
 * results a later model step delivers as a `task.result` message.
 */
export function routeDetachedResult<T extends Session>(
  session: T,
  record: Parameters<typeof holdTaskResult>[1] & Pick<TaskRecord, "wait">,
  outcome: TaskOutcome,
): { readonly session: T; readonly result?: RuntimeToolResultActionResult } {
  const waited = takeLiveWait(session, record, outcome);
  if (waited.result !== undefined) return waited;
  return { session: holdTaskResult(waited.session, record, outcome) };
}

/**
 * Gives the live `task_wait` on `record` the outcome as its tool result,
 * marks the generation delivered, and clears the wait. A wait whose call no
 * longer waits is cleared and gets nothing.
 */
export function takeLiveWait<T extends Session>(
  session: T,
  record: Pick<TaskRecord, "generation" | "id" | "name" | "wait">,
  outcome: TaskOutcome,
): { readonly session: T; readonly result?: RuntimeToolResultActionResult } {
  const { wait } = record;
  if (wait === undefined) return { session };
  const table = setTaskWait(getTaskTable(session), record.id, undefined);
  const call = waitingCall(session.state, wait.callId);
  if (call === undefined) return { session: setTaskTable(session, table) };
  return {
    result: settledResult(call, record, outcome),
    session: setTaskTable(session, markTaskDelivered(table, record.id, record.generation)),
  };
}

/**
 * Ends waits that got no result: the given calls, or every wait when
 * `callIds` is absent. A timeout or a steering message gives each its tool
 * result; a cancelled turn's waits just end. The tasks keep working.
 */
export function endTaskWaits<T extends Session>(
  session: T,
  input: {
    readonly callIds?: readonly string[];
    readonly now: string;
    readonly reason: TaskWaitEnd;
  },
): { readonly session: T; readonly results: readonly RuntimeToolResultActionResult[] } {
  const initial = getTaskTable(session);
  let table = initial;
  const results: RuntimeToolResultActionResult[] = [];
  for (const record of initial.records) {
    const { wait } = record;
    if (wait === undefined || (input.callIds !== undefined && !input.callIds.includes(wait.callId)))
      continue;
    table = setTaskWait(table, record.id, undefined);
    const call = waitingCall(session.state, wait.callId);
    if (call === undefined || input.reason === "turn-cancelled") continue;
    const waitedMs = Math.max(0, Date.parse(input.now) - Date.parse(wait.startedAt));
    results.push(
      input.reason === "timed_out"
        ? waitResult(
            call,
            { status: "timed_out", taskId: record.id },
            renderWaitTimedOut(record.id, waitedMs),
          )
        : waitResult(
            call,
            { status: "interrupted", taskId: record.id },
            renderWaitInterrupted(record, waitedMs),
          ),
    );
  }
  return { results, session: table === initial ? session : setTaskTable(session, table) };
}

/** Owner step for {@link endTaskWaits}. */
export async function endTaskWaitsStep(input: {
  readonly callIds?: readonly string[];
  readonly reason: TaskWaitEnd;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const durable = readDurableSession(input.sessionState);
  const ended = endTaskWaits(durable, {
    callIds: input.callIds,
    now: new Date().toISOString(),
    reason: input.reason,
  });
  return {
    events: [],
    replies: [],
    results: ended.results,
    serializedContext: input.serializedContext,
    sessionState:
      ended.session === durable
        ? input.sessionState
        : replaceDurableSessionSnapshot({ session: ended.session, state: input.sessionState }),
  };
}

/**
 * The call a wait belongs to, while the turn's pending batch still holds it.
 * A batch that moved on means the wait is stale, so it never takes a result.
 */
function waitingCall(state: SessionStateMap | undefined, callId: string): WaitingCall | undefined {
  return getPendingCoordinationBatch(state)?.tasks.find((task) => task.callId === callId);
}

/** The harness renders its `<task_result>` block, applying the task's `toModelOutput`. */
function settledResult(
  call: WaitingCall,
  record: Pick<TaskRecord, "id" | "name">,
  outcome: TaskOutcome,
): RuntimeToolResultActionResult {
  const settled: JsonObject =
    outcome.status === "failed"
      ? { error: { ...outcome.error }, status: "failed" }
      : { ...outcome };
  return {
    callId: call.callId,
    kind: "tool-result",
    output: { name: record.name, outcome: settled, status: "settled", taskId: record.id },
    toolName: call.toolName,
  };
}

function waitResult(
  call: WaitingCall,
  output: Exclude<TaskWaitOutput, { readonly status: "settled" }>,
  modelOutput: string,
): RuntimeToolResultActionResult {
  return { callId: call.callId, kind: "tool-result", modelOutput, output, toolName: call.toolName };
}
