import type { JsonObject } from "#shared/json.js";
import { isTerminalTaskStatus, type TaskMessage, type TaskOutcome } from "#tasks/protocol.js";
import { childCallId, isOpenResumableTask, type TaskRecord, type TaskSend } from "#tasks/record.js";
import { TASK_ENDED_BEFORE_READ_MESSAGE, TASK_ENDED_BEFORE_REPLY_MESSAGE } from "#tasks/render.js";
import {
  cancelConfirmBy,
  findTask,
  generationDeadline,
  issueCommand,
  replaceRecord,
  settleRecord,
  withoutUndefined,
  type TaskEffect,
  type TaskTable,
  type TaskTransition,
} from "#tasks/table.js";

// The owner table's generation transitions for resumable tasks: each send, the
// generation it starts, and the task's end. The owner attributes generations
// itself: a child reads its sends in order, so when a generation ends, the
// oldest send it did not read starts the next one. Agents and workflow runs
// share this path. Records change only in `tasks/table*.ts`.

export type SendTaskResult =
  /** A replayed send; its command already went out. */
  | { readonly kind: "existing"; readonly record: TaskRecord }
  | {
      readonly kind: "sent";
      readonly table: TaskTable;
      readonly record: TaskRecord;
      /** The send started the task's next generation at once: the task was idle. */
      readonly started: boolean;
      /** The input command for the child, unless it is an idle agent's next turn. */
      readonly effects: readonly TaskEffect[];
    };

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
      started: false,
      table: commanded.table,
    };
  }
  const next = nextGeneration({ ...record, lastSeq: seq }, send, input.now, {
    mode: input.mode ?? "detached",
    timeoutMs: input.timeoutMs,
    workflowCaller: input.workflowCaller,
  });
  const started = replaceRecord(table, next);
  if (next.kind === "agent") {
    return { effects: [], kind: "sent", record: next, started: true, table: started };
  }
  const commanded = issueCommand(started, next, command);
  return {
    effects: commanded.effects,
    kind: "sent",
    record: next,
    started: true,
    table: commanded.table,
  };
}

/** Forgets a send its child never received, so no generation waits for it. */
export function withdrawSend(table: TaskTable, taskId: string, seq: number): TaskTable {
  const record = findTask(table, taskId);
  const sends = record?.sends?.filter((send) => send.seq !== seq);
  if (record === undefined || sends === undefined || sends.length === record.sends?.length) {
    return table;
  }
  return replaceRecord(
    table,
    withoutUndefined({ ...record, sends: sends.length === 0 ? undefined : sends }),
  );
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

/** The record's sends without those read and the one that started the current generation. */
export function withoutSends(
  record: TaskRecord,
  read: readonly number[],
): readonly TaskSend[] | undefined {
  const rest = record.sends?.filter(
    (send) => !read.includes(send.seq) && send.seq !== record.startedBy,
  );
  return rest === undefined || rest.length === 0 ? undefined : rest;
}

/**
 * Starts a settled task's next generation with its oldest unread send. A
 * send cancelled with the task's work settles `cancelled` at once: a
 * workflow run reports that generation too, which confirms it, while an
 * agent dropped the message with its cancelled turn.
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
    if (send.cancelled !== true) {
      next = started;
      effects.push({ kind: "started", record: next });
      break;
    }
    next = cancelledGeneration(started, send, now);
    effects.push({ kind: "cancelled", record: next });
    send = next.sends?.[0];
  }
  return { effects, table: replaceRecord(table, next) };
}

/**
 * Ends the task: it takes no more input. A generation still working fails,
 * and each send the child never read still gets the generation it would have
 * started, which fails at once (or settles `cancelled` when a cancel stopped
 * it), so every send has one result. `unread` lists the sends a workflow run
 * reported unread; the owner's own list decides.
 */
export function endTask(
  table: TaskTable,
  record: TaskRecord,
  now: string,
  unread: readonly number[] = [],
): TaskTransition {
  const effects: TaskEffect[] = [];
  let next: TaskRecord = withoutUndefined({ ...record, cancelConfirmBy: undefined });
  if (!isTerminalTaskStatus(next.status)) {
    const neverRead = next.startedBy !== undefined && unread.includes(next.startedBy);
    const outcome = endedOutcome(
      neverRead ? TASK_ENDED_BEFORE_READ_MESSAGE : TASK_ENDED_BEFORE_REPLY_MESSAGE,
    );
    next = settleRecord(next, outcome);
    effects.push({ kind: "settled", outcome, record: next });
  }
  for (const send of withoutSends(next, []) ?? []) {
    const started = nextGeneration(next, send, now);
    if (send.cancelled === true) {
      next = cancelledGeneration(started, send, now);
      effects.push({ kind: "cancelled", record: next });
      continue;
    }
    const outcome = endedOutcome(TASK_ENDED_BEFORE_READ_MESSAGE);
    effects.push({ kind: "started", record: started });
    next = settleRecord(started, outcome);
    effects.push({ kind: "settled", outcome, record: next });
  }
  next = withoutUndefined({
    ...next,
    cancelConfirmBy: undefined,
    child: undefined,
    ended: true as const,
    sends: undefined,
  });
  effects.push({ kind: "ended", record: next });
  return { effects, table: replaceRecord(table, next) };
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
  const rest = record.sends?.filter((entry) => entry.seq !== send.seq);
  const { deadlineAt, timeoutMs } = generationDeadline(fresh?.timeoutMs ?? record.timeoutMs, now);
  return withoutUndefined<TaskRecord>({
    ...record,
    callId: send.callId,
    cancelConfirmBy: undefined,
    childCallId: continues ? childCallId(record) : undefined,
    clockStoppedAt: undefined,
    deadlineAt,
    delivered: false,
    generation: record.generation + 1,
    input: undefined,
    mode: fresh?.mode ?? "detached",
    sends: continues ? record.sends : rest !== undefined && rest.length > 0 ? rest : undefined,
    startedAt: now,
    startedBy: send.seq,
    status: "working",
    timeoutMs,
    turnId: send.turnId,
    wait: undefined,
    workflowCaller: fresh?.workflowCaller,
  });
}

function cancelledGeneration(started: TaskRecord, send: TaskSend, now: string): TaskRecord {
  const rest = started.sends?.filter((entry) => entry.seq !== send.seq);
  return withoutUndefined({
    ...settleRecord(started, { status: "cancelled" }),
    cancelConfirmBy: started.kind === "workflow" ? cancelConfirmBy(started, now) : undefined,
    delivered: true,
    sends: rest !== undefined && rest.length > 0 ? rest : undefined,
  });
}

function endedOutcome(message: string): TaskOutcome {
  return { error: { code: "EXECUTION_FAILED", message }, status: "failed" };
}
