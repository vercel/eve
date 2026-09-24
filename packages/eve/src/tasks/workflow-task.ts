import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { workflowToolRunOutcomeToToolResult } from "#execution/tools/workflow/owner-inbox.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { toError } from "#shared/errors.js";
import { settledEvents, taskStartedEvent } from "#tasks/events.js";
import { toTaskError } from "#tasks/outcome.js";
import type { TaskOwnerUpdate } from "#tasks/owner.js";
import type { ChildAddress, TaskOutcome } from "#tasks/protocol.js";
import { readTasks } from "#tasks/read.js";
import type { TaskRecord } from "#tasks/record.js";
import { findWorkflowTask, setTaskTable } from "#tasks/state.js";
import { applyTaskMessage, findTask, markTaskDelivered, startTask } from "#tasks/table.js";

// Owner-side lifecycle of workflow tool calls: each call is a task whose
// child is one workflow tool run.

const log = createLogger("tasks.workflow");

/**
 * Starts one workflow tool call as a task. The record is committed before
 * the run starts, so the task has its identity first; a replayed call whose
 * record exists starts nothing. A start failure settles the task
 * `START_FAILED` and returns the call's error result at once.
 */
export async function startWorkflowTask<
  T extends { readonly sessionId: string; readonly state?: SessionStateMap },
>(input: {
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
  const started = startTask(readTasks(session), {
    callId: request.callId,
    kind: "workflow",
    mode: "foreground",
    name: request.toolName,
    now,
    ownerId: session.sessionId,
    turnId: input.turnId,
  });
  // The replayed call's run already started; its outcome settles this record.
  if (started.kind === "existing") return { events: [], session };
  if (started.kind !== "started") {
    throw new Error(`Workflow tool call "${request.callId}" cannot continue an agent.`);
  }
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
  return {
    events: [
      taskStartedEvent({
        child,
        ownerSessionId: session.sessionId,
        record: findTask(adopted.table, record.id)!,
      }),
    ],
    session: setTaskTable(session, adopted.table),
  };
}

/**
 * Applies a workflow tool run's outcome to its task. The first outcome of a
 * working task settles it and becomes the waiting call's tool result; the
 * outcome of a task the owner cancelled only confirms the stop. An outcome
 * that matches no task is dropped.
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
  const table = readTasks(session);
  const record = findWorkflowTask(table, from);
  if (record === undefined) {
    return {
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  const result = workflowToolRunOutcomeToToolResult(input.message);
  const applied = applyTaskMessage(
    table,
    {
      generation: record.generation,
      kind: "task.settled",
      outcome: toWorkflowTaskOutcome(input.message, result),
      taskId: record.id,
    },
    input.now,
  );
  const settled = applied.effects.some((effect) => effect.kind === "settled");
  // The result goes straight to the waiting turn, so it is delivered now.
  const next = settled
    ? markTaskDelivered(applied.table, record.id, record.generation)
    : applied.table;
  return {
    events: settledEvents(applied.effects),
    replies: [],
    results: settled ? [result] : [],
    serializedContext: input.serializedContext,
    sessionState: replaceDurableSessionSnapshot({
      // Withdraw the finished run's unanswered requests so a late answer cannot reach it.
      session: clearProxyInputRequestsWhere(
        setTaskTable(session, next),
        (route) => route.answerHook?.runId === from.runId,
      ),
      state: input.sessionState,
    }),
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
