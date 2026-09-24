import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { isInactiveTimeoutTarget } from "#execution/session/timeout-steps.js";
import { resolveHookOwnerRunId, resolveSessionOwnerRunId } from "#execution/workflow-runtime.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
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
import { evaluateTaskDeadlines, markTaskDelivered, type TaskEffect } from "#tasks/table.js";
import { runCommands } from "#tasks/transport.js";
import {
  flushAgentInvocationTraces,
  invocationError,
  recordNestedAgentInvocationTerminal,
} from "#tracing/agent-invocation-terminal.js";

// Owner-side handling of the timer's `task.deadline` signal: time out due
// tasks, and hard-stop children that did not confirm a stop in time.
// Nothing here waits on a child.

const HARD_STOP_REASON = "The task did not stop within its cancellation window.";

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
    armed !== undefined &&
    input.signal.wakeAt === armed.wakeAt &&
    input.signal.ownerRunId === armed.ownerRunId
      ? Math.max(Date.parse(input.now), Date.parse(armed.wakeAt))
      : Date.parse(input.now);
  const now = new Date(nowMs).toISOString();

  const evaluated = evaluateTaskDeadlines(readTasks(session), now);
  let table = evaluated.table;
  let serializedContext = input.serializedContext;
  const results: RuntimeToolResultActionResult[] = [];
  const replies: WorkflowCallerReply[] = [];
  // Background results are delivered by a later model step, not to a caller.
  const held: { readonly outcome: TaskOutcome; readonly record: TaskRecord }[] = [];
  for (const effect of evaluated.effects) {
    if (effect.kind === "unconfirmed") {
      const { child, record } = effect;
      if (child !== undefined) {
        const runId = await hardStop(child, record);
        // The stopped run can no longer take an answer.
        session = clearProxyInputRequestsWhere(session, (route) =>
          child.kind === "local"
            ? route.childContinuationToken === child.continuationToken
            : route.answerHook?.runId === runId || route.answerHook?.runId === child.runId,
        );
      }
      // A child that never confirmed its stop ends its generation's span here.
      serializedContext = recordTaskTraceTerminal({
        nowMs,
        outcome: { status: "cancelled" },
        record: effect.record,
        serializedContext,
        sessionId: session.sessionId,
      });
      continue;
    }
    if (effect.kind !== "settled" || effect.outcome.status !== "failed") continue;
    const { outcome, record } = effect;
    serializedContext = recordTaskTraceTerminal({
      nowMs,
      outcome,
      record,
      serializedContext,
      sessionId: session.sessionId,
    });
    if (record.mode === "background" && record.workflowCaller === undefined) {
      held.push({ outcome, record });
      continue;
    }
    // The result goes straight to whoever waits on the call, so it is delivered now.
    table = markTaskDelivered(table, record.id, record.generation);
    resolveCaller(record, outcome.error, { replies, results });
  }
  const commands = commandEffects(evaluated.effects);
  if (commands.length > 0) await runCommands(commands, await readContext(serializedContext));

  // Once its wake time passes the armed timer has fired; clearing it lets the
  // owner arm one for the next deadline.
  const timer = armed !== undefined && Date.parse(armed.wakeAt) > nowMs ? armed : undefined;
  // Always written, so an unreadable record is removed and cannot block handoff.
  session = setTaskTable({ ...session, state: writeTaskTimer(session.state, timer) }, table);
  for (const { outcome, record } of held) session = holdTaskResult(session, record, outcome);
  return {
    events: settledEvents(evaluated.effects),
    replies,
    results,
    serializedContext: await flushAgentInvocationTraces(serializedContext),
    sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }),
  };
}

/**
 * Terminates the child's current run. A local child may have handed off to
 * a successor run, so the run that owns its stable inbox is stopped; a
 * duplicate workflow run never ran the body, so the run that owns the
 * command hook is stopped. Returns the run it stopped.
 */
async function hardStop(
  child: NonNullable<Extract<TaskEffect, { kind: "unconfirmed" }>["child"]>,
  record: TaskRecord,
): Promise<string> {
  let runId = child.kind === "local" ? child.sessionId : child.runId;
  try {
    runId =
      child.kind === "local"
        ? await resolveSessionOwnerRunId(child.sessionId)
        : ((await resolveHookOwnerRunId(child.commandToken)) ?? child.runId);
    await cancelRun(await getWorld(), runId, { cancelReason: HARD_STOP_REASON });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) {
      logError(createLogger("tasks.deadlines"), "failed to hard-stop a task child", error, {
        childKind: child.kind,
        runId,
        taskId: record.id,
      });
    }
  }
  return runId;
}

/** Ends the agent invocation span of the record's generation; later settlements are no-ops. */
function recordTaskTraceTerminal(input: {
  readonly nowMs: number;
  readonly outcome: TaskOutcome;
  readonly record: TaskRecord;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}): Record<string, unknown> {
  const { outcome, record } = input;
  if (record.kind !== "agent") return input.serializedContext;
  return recordNestedAgentInvocationTerminal({
    callId: record.callId,
    serializedContext: input.serializedContext,
    sessionId: input.sessionId,
    terminal: {
      acceptedAtMs: input.nowMs,
      error: outcome.status === "failed" ? invocationError(outcome.error) : undefined,
      outcome: outcome.status,
    },
  });
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
