import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { SessionStateMap } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import { createTaskSettledEvent, type TaskSettledStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { settledEvents } from "#tasks/events.js";
import {
  commandEffects,
  readContext,
  type TaskOwnerUpdate,
  type WorkflowCallerReply,
} from "#tasks/owner.js";
import type { TaskDeadlineSignal, TaskError, TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { STATE_LOST_MESSAGE } from "#tasks/render.js";
import { holdTaskResult } from "#tasks/results.js";
import { getTaskTable, readTaskTimer, setTaskTable, writeTaskTimer } from "#tasks/state.js";
import {
  evaluateTaskDeadlines,
  isReportedLoss,
  markTaskDelivered,
  readTaskTable,
} from "#tasks/table.js";
import { hardStopTaskChild } from "#tasks/timer-steps.js";
import { runCommands } from "#tasks/transport.js";
import { reconcileDueTasks } from "#tasks/reconcile.js";
import {
  flushAgentInvocationTraces,
  invocationError,
  recordNestedAgentInvocationTerminal,
} from "#tracing/agent-invocation-terminal.js";

// Owner-side handling of the timer's `task.deadline` signal: reconcile due
// remote and workflow tasks with one read each, time out the rest, and
// hard-stop children that did not confirm a stop in time. Nothing here waits
// on a child.

const log = createLogger("tasks.deadlines");

/** What a held result needs from its task: a record, or what an unreadable one still says. */
type HeldRecord = Parameters<typeof holdTaskResult>[1];

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
  const armed = readTaskTimer(readDurableSession(input.sessionState).state);
  // The armed timer's own signal proves its wake time passed, even when this
  // step's clock lags the clock the timer slept on.
  const nowMs =
    armed !== undefined &&
    input.signal.wakeAt === armed.wakeAt &&
    input.signal.ownerRunId === armed.ownerRunId
      ? Math.max(Date.parse(input.now), Date.parse(armed.wakeAt))
      : Date.parse(input.now);
  const now = new Date(nowMs).toISOString();

  const reconciled = await reconcileDueTasks({ ...input, now });
  let session = readDurableSession(reconciled.sessionState);
  const evaluated = evaluateTaskDeadlines(getTaskTable(session), now);
  let table = evaluated.table;
  let serializedContext = reconciled.serializedContext;
  const results: RuntimeToolResultActionResult[] = [...reconciled.results];
  const replies: WorkflowCallerReply[] = [...reconciled.replies];
  // Background results are delivered by a later model step, not to a caller.
  const held: { readonly outcome: TaskOutcome; readonly record: HeldRecord }[] = [];
  for (const effect of evaluated.effects) {
    if (effect.kind === "unconfirmed") {
      const { child, record } = effect;
      if (child !== undefined) await hardStopTaskChild(child, record.id);
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

  const lost = reportLostTasks(session, { replies, results });
  held.push(...lost.held);

  // Once its wake time passes the armed timer has fired; clearing it lets the
  // owner arm one for the next deadline.
  const timer = armed !== undefined && Date.parse(armed.wakeAt) > nowMs ? armed : undefined;
  // Always written, so an unreadable record is removed and cannot block handoff.
  session = setTaskTable({ ...session, state: writeTaskTimer(session.state, timer) }, table, {
    dropLost: true,
  });
  for (const { outcome, record } of held) session = holdTaskResult(session, record, outcome);
  return {
    events: [...reconciled.events, ...settledEvents(evaluated.effects), ...lost.events],
    replies,
    results,
    serializedContext: await flushAgentInvocationTraces(serializedContext),
    sessionState: replaceDurableSessionSnapshot({ session, state: reconciled.sessionState }),
  };
}

/**
 * Fails each task whose record could not be read with `STATE_LOST`, through
 * the same routes as any outcome: a waited call's tool result, a `ctx.agent`
 * caller's reply, or a held background result. The session continues.
 */
function reportLostTasks(
  session: { readonly state?: SessionStateMap },
  into: {
    readonly replies: WorkflowCallerReply[];
    readonly results: RuntimeToolResultActionResult[];
  },
): {
  readonly events: readonly TaskSettledStreamEvent[];
  readonly held: readonly { readonly outcome: TaskOutcome; readonly record: HeldRecord }[];
} {
  const events: TaskSettledStreamEvent[] = [];
  const held: { readonly outcome: TaskOutcome; readonly record: HeldRecord }[] = [];
  const error: TaskError = { code: "STATE_LOST", message: STATE_LOST_MESSAGE };
  for (const task of readTaskTable(session.state).lost) {
    log.warn("dropped an unreadable task record", {
      reason: task.reason,
      taskId: task.id,
      taskName: task.name,
    });
    if (!isReportedLoss(task)) continue;
    const { callId, id, name } = task;
    if (callId !== undefined) {
      events.push(createTaskSettledEvent({ callId, error, status: "failed", taskId: id }));
    }
    if (task.replyTo !== undefined || task.mode === "foreground") {
      // Only the call that waits on the task can take its outcome.
      if (callId === undefined) continue;
      resolveCaller(
        {
          callId,
          name,
          workflowCaller: task.replyTo === undefined ? undefined : { replyTo: task.replyTo },
        },
        error,
        into,
      );
      continue;
    }
    held.push({
      outcome: { error, status: "failed" },
      record: {
        creator: task.creator,
        generation: task.generation ?? 1,
        id,
        kind: task.kind ?? "workflow",
        name,
      },
    });
  }
  return { events, held };
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
  record: Pick<TaskRecord, "callId" | "name"> & {
    readonly workflowCaller?: { readonly replyTo: string };
  },
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
