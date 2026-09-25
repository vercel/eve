import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type {
  WorkflowToolRunGenerationMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunOutcomeToToolResult } from "#execution/tools/workflow/owner-inbox.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import type { SessionStateMap } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { toError } from "#shared/errors.js";
import { settledEvents, taskEvents, taskStartedEvent } from "#tasks/events.js";
import { toTaskError } from "#tasks/outcome.js";
import { cancelRunAgents } from "#tasks/cancel.js";
import { readContext, type TaskOwnerUpdate, type WorkflowCallerReply } from "#tasks/owner.js";
import {
  isTerminalTaskStatus,
  type ChildAddress,
  type TaskMessage,
  type TaskOutcome,
} from "#tasks/protocol.js";
import { AGENT_CALL_CANCELLED_MESSAGE } from "#tasks/render.js";
import type { TaskRecord } from "#tasks/record.js";
import { startReceiptResult, tooManyTasksResult } from "#tasks/receipts.js";
import { encodeTaskCreator, type TaskCreator } from "#tasks/results.js";
import { findWorkflowTask, getTaskTable, setTaskTable } from "#tasks/state.js";
import { applyTaskMessage, findTask, markTaskDelivered, startTask } from "#tasks/table.js";
import { adoptWorkflowRun } from "#tasks/table-generations.js";
import { runCommands } from "#tasks/transport.js";
import { routeSettledResults } from "#tasks/wait.js";

// Owner-side lifecycle of workflow tool calls: each call is a task whose
// child is one workflow tool run.

const log = createLogger("tasks.workflow");

/**
 * Starts one workflow tool call as a task. The task's identity is derived
 * before the run starts, and the run claims a command hook derived from it:
 * a replayed call whose record exists starts nothing, and a start retried
 * after the run began starts a duplicate that exits without running the
 * body. A start failure settles the task `START_FAILED` and returns the
 * call's error result at once. A call to an `attached: true` tool holds its
 * turn until the run's outcome; any other call is detached and returns its
 * receipt at once, unless the session is at the working-task cap.
 */
export async function startWorkflowTask<
  T extends { readonly sessionId: string; readonly state?: SessionStateMap },
>(input: {
  readonly creator?: TaskCreator;
  readonly now: string;
  readonly request: RuntimeWorkflowTaskRequest;
  readonly session: T;
  readonly startRun: (record: TaskRecord) => Promise<WorkflowToolRunAddress>;
  readonly turnId: string;
}): Promise<{
  readonly events: readonly UnstampedMessageStreamEvent[];
  readonly result?: RuntimeToolResultActionResult;
  readonly session: T;
}> {
  const { now, request, session } = input;
  const detached = request.attached !== true;
  const table = getTaskTable(session);
  const started = startTask(table, {
    callId: request.callId,
    creator: input.creator === undefined ? undefined : encodeTaskCreator(input.creator),
    kind: "workflow",
    mode: detached ? "detached" : "attached",
    name: request.toolName,
    now,
    ownerId: session.sessionId,
    resumable: request.resumable === true,
    // Workflow tools have no default limit beyond the session lifetime.
    timeoutMs: request.timeout,
    turnId: input.turnId,
  });
  // The replayed call's run already started; its outcome settles this record.
  if (started.kind === "existing") {
    const receipt = detached ? startReceiptResult(started.record, request.toolName) : undefined;
    return receipt === undefined
      ? { events: [], session }
      : { events: [], result: receipt, session };
  }
  const rejected = detached
    ? tooManyTasksResult({ callId: request.callId, table, toolName: request.toolName })
    : undefined;
  if (rejected !== undefined) return { events: [], result: rejected, session };
  const { record } = started;

  let address: WorkflowToolRunAddress;
  try {
    address = await input.startRun(record);
  } catch (error) {
    logError(log, "workflow tool run failed to start", error, {
      callId: request.callId,
      taskId: record.id,
      toolName: request.toolName,
    });
    const result = createRuntimeToolResultFromValue({
      callId: request.callId,
      isError: true,
      output: toError(error),
      toolName: request.toolName,
    });
    const settled = applyTaskMessage(
      started.table,
      {
        generation: record.generation,
        kind: "task.settled",
        outcome: {
          error: { code: "START_FAILED", message: toTaskError(result.output).message },
          status: "failed",
        },
        taskId: record.id,
      },
      now,
    );
    return {
      events: settledEvents(settled.effects),
      result,
      // The error is the call's result right now, so it is already delivered.
      session: setTaskTable(
        session,
        markTaskDelivered(settled.table, record.id, record.generation),
      ),
    };
  }

  const child: ChildAddress = {
    commandToken: address.hookToken,
    kind: "workflow",
    runId: address.runId,
  };
  // The record was created in this step, so no command can be held for it.
  const adopted = applyTaskMessage(
    started.table,
    { child, generation: record.generation, kind: "task.started", taskId: record.id },
    now,
  );
  const adoptedRecord = findTask(adopted.table, record.id)!;
  const update = {
    events: [taskStartedEvent({ child, ownerSessionId: session.sessionId, record: adoptedRecord })],
    session: setTaskTable(session, adopted.table),
  };
  return detached ? { ...update, result: startReceiptResult(record, request.toolName) } : update;
}

/**
 * Applies a workflow tool run's outcome to its task. The first outcome of a
 * working task settles it: an attached call's tool result, or a detached
 * result for a live `task_wait` or a later `task.result` message. The
 * outcome of a task the owner cancelled only confirms the stop. An outcome
 * that matches no task is dropped. A resumable run reports its generations
 * instead (see `applyWorkflowGeneration`); the deadline's read of its ended
 * run arrives here, and ends the task.
 */
export async function settleWorkflowTaskStep(input: {
  readonly message: WorkflowToolRunOutcomeMessage;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  return settleWorkflowTask({ ...input, now: new Date().toISOString() });
}

export function settleWorkflowTask(input: {
  readonly message: WorkflowToolRunOutcomeMessage;
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): TaskOwnerUpdate {
  const { from } = input.message;
  const session = readDurableSession(input.sessionState);
  const table = getTaskTable(session);
  const record = findWorkflowTask(table, from);
  const unchanged = {
    events: [],
    replies: [],
    results: [],
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  };
  if (record === undefined) return unchanged;

  const result = workflowToolRunOutcomeToToolResult(input.message);
  const settledGeneration = applyTaskMessage(
    table,
    {
      generation: from.generation,
      kind: "task.settled",
      outcome: toWorkflowTaskOutcome(input.message, result),
      taskId: record.id,
    },
    input.now,
  );
  const ended =
    record.resumable === true
      ? applyTaskMessage(
          settledGeneration.table,
          { kind: "task.ended", taskId: record.id, unread: [] },
          input.now,
        )
      : { effects: [], table: settledGeneration.table };
  const applied = {
    effects: [...settledGeneration.effects, ...ended.effects],
    table: ended.table,
  };
  if (applied.effects.length === 0) return unchanged;
  const settled = applied.effects.find((effect) => effect.kind === "settled");
  const attached = settled !== undefined && record.mode === "attached";
  // An attached call's result goes straight to the turn, so it is delivered
  // now; a detached result goes to a live `task_wait`, or is held until a
  // model step delivers it.
  let next = setTaskTable(
    session,
    attached ? markTaskDelivered(applied.table, record.id, record.generation) : applied.table,
  );
  const results = attached ? [result] : [];
  if (!attached) {
    const routed = routeSettledResults(next, applied.effects);
    next = routed.session;
    results.push(...routed.results);
  }
  return {
    events: taskEvents(applied.effects, session.sessionId),
    replies: [],
    results,
    serializedContext: input.serializedContext,
    sessionState: replaceDurableSessionSnapshot({ session: next, state: input.sessionState }),
  };
}

function toWorkflowTaskOutcome(
  message: WorkflowToolRunOutcomeMessage,
  result: RuntimeToolResultActionResult,
): TaskOutcome {
  switch (message.result.status) {
    case "completed":
      return { output: result.output, status: "completed" };
    case "failed":
      return { error: toTaskError(result.output), status: "failed" };
    case "cancelled":
      return { status: "cancelled" };
  }
}

/**
 * Applies one generation message of a resumable run: a generation it started
 * (checked against the owner's own, see `adoptStartedGeneration`), a reply,
 * or the task's end. Each message names the run that sent it, which the task
 * adopts (see `adoptWorkflowRun`). A reply or the end
 * first cancels the tasks the run still owns, such as an un-awaited
 * `ctx.agent` call, so their results precede the generation's own: its
 * result could no longer reflect them. Each cancelled call's awaiting body
 * gets the cancellation. Results are detached: each goes to a live
 * `task_wait` or to a later model step.
 */
export async function applyWorkflowGenerationStep(input: {
  readonly message: WorkflowToolRunGenerationMessage;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<TaskOwnerUpdate> {
  "use step";

  const now = new Date().toISOString();
  const { message } = input;
  const session = readDurableSession(input.sessionState);
  const record = findWorkflowTask(getTaskTable(session), message.from);
  if (record === undefined) {
    return {
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }
  const { runId } = message.from;
  const table = adoptWorkflowRun(getTaskTable(session), record.id, runId);
  if (
    message.kind === "started" &&
    (message.from.generation !== record.generation || message.send !== record.startedBy)
  ) {
    log.warn("a workflow task's run started a generation the owner did not expect; adopting it", {
      expected: { generation: record.generation, send: record.startedBy },
      reported: { generation: message.from.generation, send: message.send },
      taskId: record.id,
    });
  }
  const ownedCalls =
    message.kind === "started"
      ? []
      : table.records.filter(
          (owned) => owned.workflowCaller?.runId === runId && !isTerminalTaskStatus(owned.status),
        );
  const owned =
    ownedCalls.length === 0
      ? { commands: [], events: [], table }
      : cancelRunAgents(table, new Set([runId]), now);
  const applied = applyTaskMessage(owned.table, generationTaskMessage(record, message), now);
  if (owned.commands.length > 0) {
    await runCommands(owned.commands, await readContext(input.serializedContext));
  }
  const routed = routeSettledResults(setTaskTable(session, applied.table), applied.effects);
  return {
    events: [...owned.events, ...taskEvents(applied.effects, session.sessionId)],
    replies: ownedCalls.map(cancelledCallReply),
    results: routed.results,
    serializedContext: input.serializedContext,
    sessionState: replaceDurableSessionSnapshot({
      session: routed.session,
      state: input.sessionState,
    }),
  };
}

function generationTaskMessage(
  record: TaskRecord,
  message: WorkflowToolRunGenerationMessage,
): Exclude<TaskMessage, { readonly kind: "task.deadline" }> {
  const { generation } = message.from;
  switch (message.kind) {
    case "started":
      return { generation, kind: "task.started", send: message.send, taskId: record.id };
    case "ended":
      return { kind: "task.ended", taskId: record.id, unread: message.unread };
    case "reply": {
      const outcome = toWorkflowTaskOutcome(
        { from: message.from, result: message.result },
        workflowToolRunOutcomeToToolResult({ from: message.from, result: message.result }),
      );
      return { generation, kind: "task.settled", outcome, read: message.read, taskId: record.id };
    }
  }
}

/** What a body still awaiting a `ctx.agent` call gets when the owner cancels its task. */
function cancelledCallReply(record: TaskRecord): WorkflowCallerReply {
  return {
    replyTo: record.workflowCaller!.replyTo,
    result: {
      callId: record.callId,
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: AGENT_CALL_CANCELLED_MESSAGE,
      subagentName: record.name,
    },
  };
}
