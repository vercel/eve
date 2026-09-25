import type { JsonObject } from "#shared/json.js";
import { isTerminalTaskStatus, type TaskMessage, type TaskOutcome } from "#tasks/protocol.js";
import {
  childCallId,
  hasEnded,
  isOpenResumableTask,
  type TaskRecord,
  type TaskSend,
} from "#tasks/record.js";
import {
  TASK_ENDED_BEFORE_READ_MESSAGE,
  TASK_ENDED_BEFORE_REPLY_MESSAGE,
  TASK_INPUT_UNCONFIRMED_MESSAGE,
  TASK_RESULT_LOST_MESSAGE,
} from "#tasks/render.js";
import {
  announceGeneration,
  cancelConfirmBy,
  findTask,
  generationDeadline,
  issueCommand,
  MAX_UNREAD_SENDS,
  replaceRecord,
  settleGeneration,
  withoutUndefined,
  type TaskEffect,
  type TaskTable,
  type TaskTransition,
} from "#tasks/table.js";

// The owner table's generation transitions for resumable tasks: each send, the
// generation it starts, and the task's end. The owner attributes generations
// itself: a child reads its sends in order, so when a generation ends, the
// oldest send it did not read starts the next one. Agents and workflow runs
// share this path. An agent's generation is announced when the owner starts
// it, and an idle agent's once the agent took the turn (see
// `announceDeliveredGeneration`); a workflow run's when the run reports
// starting it, since the run decides which send it read (see
// `adoptStartedGeneration`). Records change only in `tasks/table*.ts`.

export type SendTaskResult =
  /** A replayed send; its command already went out. */
  { readonly kind: "existing"; readonly record: TaskRecord } | SentTask;

export interface SentTask {
  readonly kind: "sent";
  readonly table: TaskTable;
  readonly record: TaskRecord;
  readonly send: TaskSend;
  /** The send started the task's next generation at once: the task was idle. */
  readonly started: boolean;
  /** The input command for the child; none for an idle agent, whose next turn the owner delivers. */
  readonly effects: readonly TaskEffect[];
}

/**
 * Numbers a send and records it. An idle task starts its next generation for
 * the send's call at once; a working one queues it, and the child reads it
 * into its current work or starts its next generation with it. A workflow run
 * and a working agent get the input as a command; the owner delivers an idle
 * agent's input as its next turn. Returns `undefined` for a task that cannot
 * take a send; the owner checks the call before (see `checkSend`).
 */
export function sendTask(
  table: TaskTable,
  input: {
    readonly taskId: string;
    readonly callId: string;
    readonly turnId: string;
    readonly input: JsonObject;
    readonly now: string;
    /** An idle agent's next generation: who awaits it, and its time limit. */
    readonly mode?: TaskRecord["mode"];
    readonly workflowCaller?: TaskRecord["workflowCaller"];
    readonly timeoutMs?: number | false;
  },
): SendTaskResult | undefined {
  const record = findTask(table, input.taskId);
  if (record === undefined || !isOpenResumableTask(record)) return undefined;
  const sameCall = (entry: { readonly callId: string; readonly turnId: string }) =>
    entry.callId === input.callId && entry.turnId === input.turnId;
  if (sameCall(record) || record.sends?.some(sameCall) === true) {
    return { kind: "existing", record };
  }
  const seq = (record.lastSeq ?? 0) + 1;
  const send: TaskSend = { callId: input.callId, seq, turnId: input.turnId };
  const command = { input: input.input, kind: "input" as const, seq };
  if (!isTerminalTaskStatus(record.status) || record.cancelConfirmBy !== undefined) {
    const queued: TaskRecord = { ...record, lastSeq: seq, sends: [...(record.sends ?? []), send] };
    const commanded = issueCommand(replaceRecord(table, queued), queued, command);
    return {
      effects: commanded.effects,
      kind: "sent",
      record: queued,
      send,
      started: false,
      table: commanded.table,
    };
  }
  const next = nextGeneration({ ...record, lastSeq: seq }, send, input.now, {
    mode: input.mode ?? "detached",
    timeoutMs: input.timeoutMs,
    workflowCaller: input.workflowCaller,
  });
  if (next.kind === "agent") {
    return {
      effects: [],
      kind: "sent",
      record: next,
      send,
      started: true,
      table: replaceRecord(table, next),
    };
  }
  const started = replaceRecord(table, next);
  const commanded = issueCommand(started, next, command);
  return {
    effects: commanded.effects,
    kind: "sent",
    record: next,
    send,
    started: true,
    table: commanded.table,
  };
}

/**
 * Announces the generation an idle agent's send started, once the agent took
 * its turn: a turn it did not take is withdrawn instead (see
 * {@link withdrawSend}), so the stream never starts a generation that no
 * agent works on.
 */
export function announceDeliveredGeneration(table: TaskTable, taskId: string): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined) return { effects: [], table };
  const effects: TaskEffect[] = [];
  return { effects, table: replaceRecord(table, announceGeneration(record, effects)) };
}

/**
 * Keeps a send to a working agent that every delivery attempt failed to
 * confirm, since one may have reached it. The agent reports how many
 * messages it read, and the owner maps that count onto its oldest sends, so
 * the send stays listed where the agent would have read it. Refusing later
 * sends until a report settles it keeps it the last send: an agent that never
 * got it reads fewer, and the count never covers it. If the agent answers
 * without reading it, its generation fails at once (see
 * {@link continueWithSends}).
 */
export function markSendUnconfirmed(table: TaskTable, taskId: string, send: TaskSend): TaskTable {
  const record = findTask(table, taskId);
  if (record?.sends?.some((entry) => entry.seq === send.seq) !== true) return table;
  const sends = record.sends.map((entry) =>
    entry.seq === send.seq ? { ...entry, unconfirmed: true as const } : entry,
  );
  return replaceRecord(table, { ...record, sends });
}

/**
 * Takes back a send whose delivery failed: no generation waits for it, and
 * its number is spent, so a later send never reuses it. The failure may be
 * ambiguous, the child having taken the input before the call failed, so a
 * workflow task keeps the send's call and turn for a generation its run may
 * still report starting for it (see {@link adoptStartedGeneration}). `table`
 * may predate the send, as when the send would have started the task's next
 * generation.
 */
export function withdrawSend(table: TaskTable, taskId: string, send: TaskSend): TaskTable {
  const record = findTask(table, taskId);
  if (record === undefined) return table;
  const kept = { callId: send.callId, seq: send.seq, turnId: send.turnId };
  return replaceRecord(
    table,
    withoutUndefined({
      ...record,
      lastSeq: Math.max(record.lastSeq ?? 0, send.seq),
      sends: nonEmpty(record.sends?.filter((entry) => entry.seq !== send.seq)),
      undelivered:
        record.kind === "workflow"
          ? [...(record.undelivered ?? []), kept].slice(-MAX_UNREAD_SENDS)
          : record.undelivered,
    }),
  );
}

/**
 * Checks a generation a workflow run reports starting for a send against the
 * owner's own attribution, and adopts the run's when they differ. The run
 * is the authority on which send it read: a delivery the owner saw fail may
 * have reached it. When the owner gave that generation another send, that
 * send goes back to the front of the queue, where the run holds it. When the
 * run started a generation the owner has not, the owner starts it for that
 * send; a generation the owner still thought working settled in the run, and
 * its reply never arrived. A report of a generation further ahead means the
 * run also started and settled the ones between, whose reports were lost:
 * each settles as lost too, attributed like any generation to the oldest
 * send the owner holds before the reported one. A send the owner no longer
 * knows is attributed to the latest generation's call, the same principal's.
 * An earlier generation's report is stale.
 *
 * Sends reach the run in the order the owner numbered them, and the run
 * reads them in that order, so every send numbered below the adopted one
 * was already read or will never arrive: none of them starts a generation.
 *
 * The report announces the generation with the run's attribution, so the
 * stream starts each generation once, for the send it answers. A generation
 * the owner already settled was announced with its settle, and keeps it.
 */
export function adoptStartedGeneration(
  table: TaskTable,
  record: TaskRecord,
  generation: number,
  seq: number,
  now: string,
): TaskTransition {
  const unchanged = { effects: [], table };
  if (record.kind !== "workflow" || record.ended === true) return unchanged;
  const later = (send: TaskSend) => send.seq > seq;
  const effects: TaskEffect[] = [];
  if (generation === record.generation) {
    if (record.startedBy === seq) {
      if (record.announced === true) return unchanged;
      const confirmed = announceGeneration(record, effects);
      return { effects, table: replaceRecord(table, confirmed) };
    }
    // A generation the owner already stopped stopped the run's work on its send too.
    const displaced: TaskSend[] =
      record.startedBy === undefined
        ? []
        : [
            withoutUndefined({
              callId: record.callId,
              cancelled: isTerminalTaskStatus(record.status) ? (true as const) : undefined,
              seq: record.startedBy,
              turnId: record.turnId,
            }),
          ];
    const send = knownSend(record, seq);
    const adopted = withoutUndefined({
      ...record,
      callId: send.callId,
      sends: nonEmpty([...displaced, ...(record.sends ?? [])].filter(later)),
      startedBy: seq,
      turnId: send.turnId,
      undelivered: nonEmpty(record.undelivered?.filter(later)),
    });
    const next = isTerminalTaskStatus(adopted.status)
      ? adopted
      : announceGeneration(adopted, effects);
    return { effects, table: replaceRecord(table, next) };
  }
  const skipped = [...(record.sends ?? []), ...(record.undelivered ?? [])]
    .filter((send) => send.seq < seq)
    .toSorted((left, right) => left.seq - right.seq);
  // Each generation between started for one of those sends; a report further ahead is unrecoverable.
  if (generation < record.generation || generation - record.generation - 1 > skipped.length) {
    return unchanged;
  }
  const lost = endedOutcome(TASK_RESULT_LOST_MESSAGE);
  let current = record;
  if (!isTerminalTaskStatus(current.status)) {
    current = settleGeneration(current, lost, effects);
  } else if (current.cancelConfirmBy !== undefined) {
    current = withoutUndefined({ ...current, cancelConfirmBy: undefined });
    effects.push({ kind: "confirmed", record: current });
  }
  for (const send of skipped.slice(0, generation - record.generation - 1)) {
    const started = nextGeneration(current, send, now);
    // The run is past a cancelled send's generation, so no confirmation of it is coming.
    current =
      send.cancelled === true
        ? settleGeneration({ ...started, delivered: true }, { status: "cancelled" }, effects, {
            cancelled: true,
          })
        : settleGeneration(started, lost, effects);
  }
  const send = knownSend(current, seq);
  const rest = withoutUndefined({
    ...current,
    sends: nonEmpty(current.sends?.filter(later)),
    undelivered: nonEmpty(current.undelivered?.filter(later)),
  });
  const started = nextGeneration(rest, send, now);
  const next =
    send.cancelled === true
      ? cancelledGeneration(started, send, now, effects)
      : announceGeneration(started, effects);
  return { effects, table: replaceRecord(table, next) };
}

/**
 * Points a workflow task at the run that reports for it. A start retried
 * after the run began records the duplicate run, which exits at once: only
 * the run that claimed the task's command hook reports, and cancels, hard
 * stops, and deadline reads must reach that run.
 */
export function adoptWorkflowRun(table: TaskTable, taskId: string, runId: string): TaskTable {
  const record = findTask(table, taskId);
  if (record?.child?.kind !== "workflow" || record.child.runId === runId) return table;
  return replaceRecord(table, { ...record, child: { ...record.child, runId } });
}

/**
 * The sends a child read during its current generation: a workflow body
 * lists them; an agent counts the messages it received, which are its oldest
 * unread sends.
 */
export function readSendSeqs(
  record: TaskRecord,
  message: Pick<Extract<TaskMessage, { kind: "task.settled" }>, "read" | "steers">,
): readonly number[] {
  if (message.read !== undefined) return message.read;
  if (record.kind !== "agent" || message.steers === undefined) return [];
  return (record.sends ?? []).slice(0, message.steers).map((send) => send.seq);
}

/**
 * The record's sends without those read and the one that started the
 * current generation, and its undelivered sends without those read.
 */
export function withoutRead(
  record: TaskRecord,
  read: readonly number[],
): Pick<TaskRecord, "sends" | "undelivered"> {
  return {
    sends: nonEmpty(
      record.sends?.filter((send) => !read.includes(send.seq) && send.seq !== record.startedBy),
    ),
    undelivered: nonEmpty(record.undelivered?.filter((send) => !read.includes(send.seq))),
  };
}

/**
 * Starts a settled task's next generation with its oldest unread send. A
 * send cancelled with the task's work starts and settles `cancelled` at
 * once: a workflow run reports that generation too, which confirms it,
 * while an agent dropped the message with its cancelled turn. An agent that
 * answered without reading a send it may never have received fails that
 * send's generation at once: no turn is coming for it, and one that does
 * come answers a call the task no longer waits on.
 */
export function continueWithSends(
  table: TaskTable,
  record: TaskRecord,
  now: string,
): TaskTransition {
  const effects: TaskEffect[] = [];
  let next = record;
  let send = next.sends?.[0];
  while (
    send !== undefined &&
    next.ended !== true &&
    isTerminalTaskStatus(next.status) &&
    next.cancelConfirmBy === undefined
  ) {
    const started = nextGeneration(next, send, now);
    if (send.cancelled === true) {
      next = cancelledGeneration(started, send, now, effects);
    } else if (send.unconfirmed === true) {
      const seq = send.seq;
      next = settleGeneration(
        { ...started, sends: nonEmpty(started.sends?.filter((entry) => entry.seq !== seq)) },
        {
          error: { code: "TASK_UNREACHABLE", message: TASK_INPUT_UNCONFIRMED_MESSAGE },
          status: "failed",
        },
        effects,
      );
    } else {
      next = started.kind === "agent" ? announceGeneration(started, effects) : started;
      break;
    }
    send = next.sends?.[0];
  }
  return { effects, table: replaceRecord(table, next) };
}

/**
 * Ends the task: it takes no more input. A generation still working fails,
 * and each send the child never read still gets the generation it would have
 * started, which starts and fails at once (or settles `cancelled` when a
 * cancel stopped it), so every send has one result. Then the task ends, once.
 * `unread` lists the sends a workflow run reported unread; the owner's own
 * list decides.
 */
export function endTask(
  table: TaskTable,
  record: TaskRecord,
  now: string,
  unread: readonly number[] = [],
): TaskTransition {
  if (hasEnded(record)) return { effects: [], table };
  const effects: TaskEffect[] = [];
  let next: TaskRecord = withoutUndefined({ ...record, cancelConfirmBy: undefined });
  if (!isTerminalTaskStatus(next.status)) {
    const neverRead = next.startedBy !== undefined && unread.includes(next.startedBy);
    const outcome = endedOutcome(
      neverRead ? TASK_ENDED_BEFORE_READ_MESSAGE : TASK_ENDED_BEFORE_REPLY_MESSAGE,
    );
    next = settleGeneration(next, outcome, effects);
    // A task that is not resumable ended with its only generation.
    if (hasEnded(next)) return { effects, table: replaceRecord(table, next) };
  }
  for (const send of withoutRead(next, []).sends ?? []) {
    const started = nextGeneration(next, send, now);
    next =
      send.cancelled === true
        ? cancelledGeneration(started, send, now, effects)
        : settleGeneration(started, endedOutcome(TASK_ENDED_BEFORE_READ_MESSAGE), effects);
  }
  next = withoutUndefined({
    ...next,
    cancelConfirmBy: undefined,
    child: undefined,
    ended: true as const,
    sends: undefined,
    undelivered: undefined,
  });
  effects.push({ kind: "ended", record: next });
  return { effects, table: replaceRecord(table, next) };
}

/** Ends every task that has not ended yet: the owner session is ending. */
export function endAllTasks(table: TaskTable, now: string): TaskTransition {
  let next = table;
  const effects: TaskEffect[] = [];
  for (const { id } of table.records) {
    const ended = endTask(next, findTask(next, id)!, now);
    next = ended.table;
    effects.push(...ended.effects);
  }
  return { effects, table: next };
}

/**
 * The generation a send starts. An agent reads the send that starts its next
 * turn among its messages and keeps answering the same call, so the send
 * stays listed until the agent answers; an idle agent's next turn is a new
 * call (`fresh`).
 */
function nextGeneration(
  record: TaskRecord,
  send: TaskSend,
  now: string,
  fresh?: {
    readonly mode: TaskRecord["mode"];
    readonly workflowCaller?: TaskRecord["workflowCaller"];
    readonly timeoutMs?: number | false;
  },
): TaskRecord {
  const continues = record.kind === "agent" && fresh === undefined;
  const { deadlineAt, timeoutMs } = generationDeadline(fresh?.timeoutMs ?? record.timeoutMs, now);
  return withoutUndefined<TaskRecord>({
    ...record,
    announced: undefined,
    callId: send.callId,
    cancelConfirmBy: undefined,
    childCallId: continues ? childCallId(record) : undefined,
    clockStoppedAt: undefined,
    deadlineAt,
    delivered: false,
    generation: record.generation + 1,
    input: undefined,
    mode: fresh?.mode ?? "detached",
    sends: continues
      ? record.sends
      : nonEmpty(record.sends?.filter((entry) => entry.seq !== send.seq)),
    startedAt: now,
    startedBy: send.seq,
    status: "working",
    timeoutMs,
    turnId: send.turnId,
    wait: undefined,
    workflowCaller: fresh?.workflowCaller,
  });
}

/** Starts and settles `cancelled` a generation for a send a cancel stopped. */
function cancelledGeneration(
  started: TaskRecord,
  send: TaskSend,
  now: string,
  effects: TaskEffect[],
): TaskRecord {
  return settleGeneration(
    withoutUndefined({
      ...started,
      cancelConfirmBy: started.kind === "workflow" ? cancelConfirmBy(started, now) : undefined,
      delivered: true,
      sends: nonEmpty(started.sends?.filter((entry) => entry.seq !== send.seq)),
    }),
    { status: "cancelled" },
    effects,
    { cancelled: true },
  );
}

function endedOutcome(message: string): TaskOutcome {
  return { error: { code: "EXECUTION_FAILED", message }, status: "failed" };
}

/** A send by its number: queued, undelivered, or else the latest generation's call. */
function knownSend(record: TaskRecord, seq: number): TaskSend {
  return (
    record.sends?.find((send) => send.seq === seq) ??
    record.undelivered?.find((send) => send.seq === seq) ?? {
      callId: record.callId,
      seq,
      turnId: record.turnId,
    }
  );
}

function nonEmpty<T>(values: readonly T[] | undefined): readonly T[] | undefined {
  return values === undefined || values.length === 0 ? undefined : values;
}
