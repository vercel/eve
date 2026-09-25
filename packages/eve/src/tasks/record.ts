import type { JsonObject } from "#shared/json.js";
import type {
  ChildAddress,
  TaskCommand,
  TaskInputBatch,
  TaskKind,
  TaskMode,
  TaskStatus,
} from "#tasks/protocol.js";

export const TASK_RECORD_VERSION = 1;

/**
 * The owner's durable record of one task. Records retain no outputs: a
 * task's output lives in history, as a tool result or a task result message.
 */
export interface TaskRecord {
  readonly v: typeof TASK_RECORD_VERSION;
  /** `<name>-<6 base32>`, assigned by the owner before start and unique in its table. */
  readonly id: string;
  /** One unit of work: a send to a resumable task starts its next generation. */
  readonly generation: number;
  /** The tool call that started the current generation: the start, or a send. */
  readonly callId: string;
  /** The owner turn that started the current generation. */
  readonly turnId: string;
  readonly name: string;
  readonly kind: TaskKind;
  readonly mode: TaskMode;
  readonly status: TaskStatus;
  /** Runtime graph node of the agent definition; agents only. */
  readonly nodeId?: string;
  /** Absent until the child reports `task.started`. */
  readonly child?: ChildAddress;
  /** ISO time the current generation started. */
  readonly startedAt: string;
  /** The principal that started the task; only it can wait on, cancel, or continue it. */
  readonly creator?: JsonObject;
  /** ISO time the current generation times out. Absent means only the session lifetime bounds it. */
  readonly deadlineAt?: string;
  /** The current generation's time limit in milliseconds of active time, present with `deadlineAt`. */
  readonly timeoutMs?: number;
  /** Set while the task waits on a human; the deadline clock is stopped. */
  readonly clockStoppedAt?: string;
  /** After cancellation, the owner hard-stops a local child that has not confirmed by then. */
  readonly cancelConfirmBy?: string;
  /**
   * Commands issued before the child reported `task.started`. Each input
   * among them is also one of `sends`, so the unread cap bounds them.
   */
  readonly pendingCommands?: readonly TaskCommand[];
  /**
   * The `input.requested` batches the task waits on. The task is
   * `input_required` exactly while it or `signIns` is present.
   */
  readonly input?: readonly TaskInputBatch[];
  /** The sign-ins the task waits on, one per authorization source and the task that asked. */
  readonly signIns?: readonly string[];
  /** One-line summary of the latest result, listed with idle tasks in the `[Tasks]` note. */
  readonly lastStatus?: string;
  /** The task takes more input by `taskId`: every agent, and a `resumable: true` workflow tool. */
  readonly resumable?: true;
  /**
   * The stream announced the current generation (`task.started`). A
   * generation is announced once its start is certain, and at the latest
   * with its settle, so every `task.settled` follows its `task.started`.
   */
  readonly announced?: true;
  /** The resumable task stopped taking input. A send to it fails `UNKNOWN_TASK`. */
  readonly ended?: true;
  /**
   * Sends the child has not read yet, oldest first. When a generation ends,
   * the oldest starts the next one. An agent counts the send that starts its
   * next turn among the messages it reads, so that send stays listed until
   * the agent answers.
   */
  readonly sends?: readonly TaskSend[];
  /** The last send number the owner assigned, delivered or not: numbers never repeat. */
  readonly lastSeq?: number;
  /**
   * Sends whose delivery failed, oldest first and at most the unread cap. A
   * failed delivery may still have reached the run, so a generation the run
   * reports starting for one takes that send's call and turn. Workflow tasks
   * only: an agent reports how many messages it read, not which.
   */
  readonly undelivered?: readonly TaskSend[];
  /** The send that started the current generation. */
  readonly startedBy?: number;
  /**
   * The call an agent answers under, when it differs from `callId`: a
   * generation started by a send the agent read after answering continues
   * the call it was answering.
   */
  readonly childCallId?: string;
  /**
   * The place of the last child answer applied to this agent. The child's
   * answers only grow, so a report at or below it repeats an answer already
   * applied, such as an earlier generation's, and settles nothing.
   */
  readonly answerSeq?: number;
  /** Set when a workflow tool body started the current generation; its result goes to this reply hook. */
  readonly workflowCaller?: { readonly runId: string; readonly replyTo: string };
  /** The current generation's result reached history. */
  readonly delivered: boolean;
  /** The `task_wait` call that takes the current generation's result, while it waits. */
  readonly wait?: { readonly callId: string; readonly startedAt: string };
}

/** One send to a resumable task, with the call and turn a generation it starts belongs to. */
export interface TaskSend {
  readonly seq: number;
  readonly callId: string;
  readonly turnId: string;
  /** Cancelled with the task's work: its generation settles `cancelled`, unseen by the model. */
  readonly cancelled?: true;
  /**
   * An agent may not have this send: every delivery attempt failed, and one
   * got no answer. It stays listed, so the agent's count of messages it read
   * maps onto the sends it may have, and it is the task's last send until a
   * report settles it (see `markSendUnconfirmed`).
   */
  readonly unconfirmed?: true;
}

/**
 * The task stopped taking input and published `task.ended`: a resumable task
 * that ended, or any other task once its only generation settled.
 */
export function hasEnded(record: TaskRecord): boolean {
  return (
    record.ended === true ||
    (record.resumable !== true &&
      (record.status === "completed" ||
        record.status === "failed" ||
        record.status === "cancelled"))
  );
}

/** A resumable task that has not ended: sends can reach it. */
export function isOpenResumableTask(record: TaskRecord): boolean {
  return record.resumable === true && record.ended !== true;
}

/**
 * A resumable task whose latest generation settled, whose result reached
 * history, and whose child still runs: it takes its next generation from a
 * send. A task still confirming a cancel, or with sends queued, is not idle.
 */
export function isIdleTask(record: TaskRecord): boolean {
  return (
    isOpenResumableTask(record) &&
    record.child !== undefined &&
    record.delivered &&
    record.cancelConfirmBy === undefined &&
    record.sends === undefined &&
    (record.status === "completed" || record.status === "failed" || record.status === "cancelled")
  );
}

/** The call an agent's child reports under for the current generation. */
export function childCallId(record: Pick<TaskRecord, "callId" | "childCallId">): string {
  return record.childCallId ?? record.callId;
}

/**
 * What an unreadable record still says about its task, read field by field,
 * so the owner can report the loss to whoever waits on the task.
 */
export interface RecoveredTaskFields {
  readonly id?: string;
  readonly name?: string;
  readonly callId?: string;
  readonly generation?: number;
  readonly kind?: TaskKind;
  readonly mode?: TaskMode;
  /** Absent when unreadable: the generation may still be working. */
  readonly status?: TaskStatus;
  /** The stream announced the current generation, as on a readable record. */
  readonly announced?: true;
  readonly resumable?: true;
  readonly ended?: true;
  readonly creator?: JsonObject;
  /** Reply hook of the `ctx.agent` call waiting on the task. */
  readonly replyTo?: string;
  readonly delivered?: boolean;
  /** The `task_wait` call waiting on the task, which takes the loss as its result. */
  readonly wait?: TaskRecord["wait"];
}

export type TaskRecordDecodeResult =
  | { readonly ok: true; readonly record: TaskRecord }
  | ({ readonly ok: false; readonly reason: string } & RecoveredTaskFields);

const KINDS = new Set<TaskKind>(["agent", "workflow"]);
const MODES = new Set<TaskMode>(["attached", "detached"]);
const STATUSES = new Set<TaskStatus>([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

// Decoding runs inside the workflow driver: importing a schema runtime here
// also embeds it in every deployed workflow function.
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isIsoTime(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value));
}

function isOptionalIsoTime(value: unknown): boolean {
  return value === undefined || isIsoTime(value);
}

function isChildAddress(value: unknown): value is ChildAddress {
  if (!isRecordObject(value)) return false;
  switch (value.kind) {
    case "workflow":
      return isString(value.runId) && isString(value.commandToken);
    case "local":
      return isString(value.sessionId) && isString(value.continuationToken);
    case "remote":
      return (
        isString(value.sessionId) &&
        isString(value.url) &&
        isString(value.callbackBaseUrl) &&
        isOptionalString(value.credentialResolver)
      );
    default:
      return false;
  }
}

function isTaskCommand(value: unknown): value is TaskCommand {
  if (!isRecordObject(value)) return false;
  switch (value.kind) {
    case "cancel":
      return true;
    case "answer":
      return Array.isArray(value.responses);
    case "input":
      return isCount(value.seq) && isRecordObject(value.input);
    default:
      return false;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTaskSend(value: unknown): value is TaskSend {
  return (
    isRecordObject(value) &&
    isCount(value.seq) &&
    isString(value.callId) &&
    isString(value.turnId) &&
    (value.cancelled === undefined || value.cancelled === true) &&
    (value.unconfirmed === undefined || value.unconfirmed === true)
  );
}

// The shape the owner routes answers by; the child validates each answer.
function isInputBatch(value: unknown): value is TaskInputBatch {
  return (
    isRecordObject(value) &&
    isString(value.turnId) &&
    isCount(value.sequence) &&
    isCount(value.stepIndex) &&
    isOptionalString(value.from) &&
    Array.isArray(value.requests) &&
    value.requests.length > 0 &&
    value.requests.every(
      (request) =>
        isRecordObject(request) &&
        isString(request.requestId) &&
        isString(request.kind) &&
        (request.dismissible === undefined || typeof request.dismissible === "boolean"),
    )
  );
}

/** Decodes one record on its own, so one bad record never fails the table. */
export function decodeTaskRecord(value: unknown): TaskRecordDecodeResult {
  if (!isRecordObject(value)) return { ok: false, reason: "not an object" };
  const id = isString(value.id) ? value.id : undefined;
  const name = isString(value.name) ? value.name : undefined;
  const fail = (reason: string): TaskRecordDecodeResult => ({
    ok: false,
    reason,
    ...recoverTaskFields(value),
  });
  if (value.v !== TASK_RECORD_VERSION) return fail(`unsupported version ${String(value.v)}`);
  if (id === undefined || name === undefined) return fail("missing identity");
  if (
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    return fail("invalid generation");
  if (!isString(value.callId) || !isString(value.turnId)) return fail("missing call identity");
  if (!KINDS.has(value.kind as TaskKind)) return fail("invalid kind");
  if (!MODES.has(value.mode as TaskMode)) return fail("invalid mode");
  if (!STATUSES.has(value.status as TaskStatus)) return fail("invalid status");
  if (!isOptionalString(value.nodeId)) return fail("invalid nodeId");
  if (value.child !== undefined && !isChildAddress(value.child)) return fail("invalid child");
  if (!isIsoTime(value.startedAt)) return fail("invalid startedAt");
  if (value.creator !== undefined && !isRecordObject(value.creator)) return fail("invalid creator");
  if (
    !isOptionalIsoTime(value.deadlineAt) ||
    !isOptionalIsoTime(value.clockStoppedAt) ||
    !isOptionalIsoTime(value.cancelConfirmBy)
  )
    return fail("invalid time");
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isFinite(value.timeoutMs) ||
      value.timeoutMs < 0)
  )
    return fail("invalid timeoutMs");
  if (
    value.pendingCommands !== undefined &&
    (!Array.isArray(value.pendingCommands) || !value.pendingCommands.every(isTaskCommand))
  )
    return fail("invalid pendingCommands");
  if (
    value.input !== undefined &&
    (!Array.isArray(value.input) || !value.input.every(isInputBatch))
  )
    return fail("invalid input");
  if (
    value.signIns !== undefined &&
    (!Array.isArray(value.signIns) || value.signIns.length === 0 || !value.signIns.every(isString))
  )
    return fail("invalid signIns");
  if (value.lastStatus !== undefined && typeof value.lastStatus !== "string")
    return fail("invalid lastStatus");
  if (value.resumable !== undefined && value.resumable !== true) return fail("invalid resumable");
  if (value.announced !== undefined && value.announced !== true) return fail("invalid announced");
  if (value.ended !== undefined && value.ended !== true) return fail("invalid ended");
  if (
    value.sends !== undefined &&
    (!Array.isArray(value.sends) || value.sends.length === 0 || !value.sends.every(isTaskSend))
  )
    return fail("invalid sends");
  if (value.lastSeq !== undefined && !isCount(value.lastSeq)) return fail("invalid lastSeq");
  if (
    value.undelivered !== undefined &&
    (!Array.isArray(value.undelivered) ||
      value.undelivered.length === 0 ||
      !value.undelivered.every(isTaskSend))
  )
    return fail("invalid undelivered");
  if (value.startedBy !== undefined && !isCount(value.startedBy)) return fail("invalid startedBy");
  if (!isOptionalString(value.childCallId)) return fail("invalid childCallId");
  if (value.answerSeq !== undefined && !isCount(value.answerSeq)) return fail("invalid answerSeq");
  if (
    value.workflowCaller !== undefined &&
    (!isRecordObject(value.workflowCaller) ||
      !isString(value.workflowCaller.runId) ||
      !isString(value.workflowCaller.replyTo))
  )
    return fail("invalid workflowCaller");
  if (typeof value.delivered !== "boolean") return fail("invalid delivered");
  if (
    value.wait !== undefined &&
    (!isRecordObject(value.wait) ||
      !isString(value.wait.callId) ||
      !isIsoTime(value.wait.startedAt))
  )
    return fail("invalid wait");
  const fields: Partial<Record<keyof TaskRecord, unknown>> = value;
  return { ok: true, record: fields as TaskRecord };
}

function recoverTaskFields(value: Record<string, unknown>): RecoveredTaskFields {
  const fields: { -readonly [K in keyof RecoveredTaskFields]: RecoveredTaskFields[K] } = {};
  if (isString(value.id)) fields.id = value.id;
  if (isString(value.name)) fields.name = value.name;
  if (isString(value.callId)) fields.callId = value.callId;
  if (typeof value.generation === "number" && Number.isSafeInteger(value.generation)) {
    fields.generation = value.generation;
  }
  if (KINDS.has(value.kind as TaskKind)) fields.kind = value.kind as TaskKind;
  if (MODES.has(value.mode as TaskMode)) fields.mode = value.mode as TaskMode;
  if (STATUSES.has(value.status as TaskStatus)) fields.status = value.status as TaskStatus;
  if (value.announced === true) fields.announced = true;
  if (value.resumable === true) fields.resumable = true;
  if (value.ended === true) fields.ended = true;
  if (isRecordObject(value.creator)) fields.creator = value.creator as JsonObject;
  if (isRecordObject(value.workflowCaller) && isString(value.workflowCaller.replyTo)) {
    fields.replyTo = value.workflowCaller.replyTo;
  }
  if (typeof value.delivered === "boolean") fields.delivered = value.delivered;
  if (
    isRecordObject(value.wait) &&
    isString(value.wait.callId) &&
    isIsoTime(value.wait.startedAt)
  ) {
    fields.wait = { callId: value.wait.callId, startedAt: value.wait.startedAt };
  }
  return fields;
}
