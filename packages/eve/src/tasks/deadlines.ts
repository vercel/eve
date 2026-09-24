import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { isInactiveTimeoutTarget } from "#execution/session/timeout-steps.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { settledEvents } from "#tasks/events.js";
import {
  commandEffects,
  readContext,
  type TaskOwnerUpdate,
  type WorkflowCallerReply,
} from "#tasks/owner.js";
import type { TaskDeadlineSignal, TaskError, TaskOutcome } from "#tasks/protocol.js";
import { readTasks } from "#tasks/read.js";
import type { TaskRecord } from "#tasks/record.js";
import { holdTaskResult } from "#tasks/results.js";
import { readTaskTimer, setTaskTable, writeTaskTimer } from "#tasks/state.js";
import {
  applyTaskMessage,
  evaluateTaskDeadlines,
  markTaskDelivered,
  timeOutTask,
  type TaskEffect,
  type TaskTable,
  type TaskTransition,
} from "#tasks/table.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";

// Owner-side handling of the timer's `task.deadline` signal: time out due
// tasks after one reconciliation read, and hard-stop children that did not
// confirm a cancel in time. Nothing here waits on a child.

const log = createLogger("tasks.deadlines");

const HARD_STOP_REASON = "The task did not stop within its cancellation window.";

const ENDED_WITHOUT_RESULT: TaskError = {
  code: "EXECUTION_FAILED",
  message: "The workflow run ended without reporting a result.",
};

/** Applies one timer signal. Every signal is re-evaluated, so a stale one does nothing. */
export async function applyTaskDeadlinesStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly signal: TaskDeadlineSignal;
}): Promise<TaskOwnerUpdate> {
  "use step";

  return await applyTaskDeadlines({ ...input, now: new Date().toISOString() });
}

export async function applyTaskDeadlines(input: {
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly signal: TaskDeadlineSignal;
}): Promise<TaskOwnerUpdate> {
  let session = readDurableSession(input.sessionState);
  const armed = readTaskTimer(session.state);
  // The armed timer's own signal proves its wake time passed, even when this
  // step's clock lags the clock the timer slept on.
  const nowMs =
    armed !== undefined && input.signal.wakeAt === armed.wakeAt
      ? Math.max(Date.parse(input.now), Date.parse(armed.wakeAt))
      : Date.parse(input.now);
  const now = new Date(nowMs).toISOString();

  const evaluated = evaluateTaskDeadlines(readTasks(session), now);
  let table = evaluated.table;
  const commands: CommandEffect[] = [];
  const events: UnstampedMessageStreamEvent[] = [];
  const results: RuntimeToolResultActionResult[] = [];
  const replies: WorkflowCallerReply[] = [];
  // Background results are delivered by a later model step, not to a caller.
  const held: { readonly outcome: TaskOutcome; readonly record: TaskRecord }[] = [];
  for (const effect of evaluated.effects) {
    if (effect.kind === "hard-stop") {
      await hardStop(effect);
      const { child } = effect;
      // The stopped run can no longer take an answer.
      session = clearProxyInputRequestsWhere(session, (route) =>
        child.kind === "local"
          ? route.childContinuationToken === child.continuationToken
          : route.answerHook?.runId === child.runId,
      );
      continue;
    }
    if (effect.kind !== "reconcile") continue;
    const transition = await reconcile(table, effect.record, now);
    table = transition.table;
    commands.push(...commandEffects(transition.effects));
    events.push(...settledEvents(transition.effects));
    for (const settled of transition.effects) {
      if (settled.kind !== "settled" || settled.outcome.status !== "failed") continue;
      if (settled.record.mode === "background" && settled.record.workflowCaller === undefined) {
        held.push({ outcome: settled.outcome, record: settled.record });
        continue;
      }
      // The result goes straight to whoever waits on the call, so it is delivered now.
      table = markTaskDelivered(table, settled.record.id, settled.record.generation);
      resolveCaller(settled.record, settled.outcome.error, { replies, results });
    }
  }
  if (commands.length > 0) await runCommands(commands, await readContext(input.serializedContext));

  // Once its wake time passes the armed timer has fired; clearing it lets the
  // owner arm one for the next deadline.
  const timer = armed !== undefined && Date.parse(armed.wakeAt) > nowMs ? armed : undefined;
  // Always written, so an unreadable record is removed and cannot block handoff.
  session = setTaskTable({ ...session, state: writeTaskTimer(session.state, timer) }, table);
  for (const { outcome, record } of held) session = holdTaskResult(session, record, outcome);
  return {
    events,
    replies,
    results,
    serializedContext: input.serializedContext,
    sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }),
  };
}

/**
 * One read of the child's state before timing a task out. A workflow run
 * that already ended without its outcome reaching the owner settles the task
 * `failed`. An agent's session outlives each call, so its run status says
 * nothing about this call's result, and a remote session has no read route;
 * both time out, and a result that arrives later is dropped.
 */
async function reconcile(
  table: TaskTable,
  record: TaskRecord,
  now: string,
): Promise<TaskTransition> {
  if (record.child?.kind === "workflow" && (await hasRunEnded(record.child.runId))) {
    return applyTaskMessage(
      table,
      {
        generation: record.generation,
        kind: "task.settled",
        outcome: { error: ENDED_WITHOUT_RESULT, status: "failed" },
        taskId: record.id,
      },
      now,
    );
  }
  return timeOutTask(table, record.id, now);
}

async function hasRunEnded(runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return status === "completed" || status === "failed" || status === "cancelled";
  } catch (error) {
    // A run the world no longer knows has ended.
    if (isInactiveTimeoutTarget(error)) return true;
    logError(log, "failed to read a task run's status", error, { runId });
    return false;
  }
}

async function hardStop(effect: Extract<TaskEffect, { kind: "hard-stop" }>): Promise<void> {
  const { child, record } = effect;
  const runId = child.kind === "local" ? child.sessionId : child.runId;
  try {
    await cancelRun(await getWorld(), runId, { cancelReason: HARD_STOP_REASON });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) {
      logError(log, "failed to hard-stop a task child", error, {
        childKind: child.kind,
        runId,
        taskId: record.id,
      });
    }
  }
}

function resolveCaller(
  record: TaskRecord,
  error: TaskError,
  into: {
    readonly replies: WorkflowCallerReply[];
    readonly results: RuntimeToolResultActionResult[];
  },
): void {
  const output = { code: error.code, message: error.message };
  if (record.workflowCaller !== undefined) {
    into.replies.push({
      replyTo: record.workflowCaller.replyTo,
      result: {
        callId: record.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output,
        subagentName: record.name,
      },
    });
    return;
  }
  into.results.push({
    callId: record.callId,
    isError: true,
    kind: "tool-result",
    output,
    toolName: record.name,
  });
}
