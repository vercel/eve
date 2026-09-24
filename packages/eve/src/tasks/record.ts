import type { JsonObject } from "#shared/json.js";
import type { ChildAddress, TaskCommand, TaskKind, TaskMode, TaskStatus } from "#tasks/protocol.js";

export const TASK_RECORD_VERSION = 1;

/**
 * The owner's durable record of one task. Records retain no outputs: a
 * task's output lives in history, as a tool result or a task result message.
 */
export interface TaskRecord {
  readonly v: typeof TASK_RECORD_VERSION;
  /** `<name>-<6 base32>`, assigned by the owner before start and unique in its table. */
  readonly id: string;
  /** One unit of work: a new call on an idle agent starts the next generation. */
  readonly generation: number;
  /** The tool call that started the current generation. */
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
  /** Auth and dynamic selections captured at start, replayed for result turns. */
  readonly creator?: JsonObject;
  /** Tasks detached by the same steering message share one group. */
  readonly detachGroup?: string;
  /** ISO time the current generation times out. Absent means only the session lifetime bounds it. */
  readonly deadlineAt?: string;
  /** Set while the task waits on a human; the deadline clock is stopped. */
  readonly clockStoppedAt?: string;
  /** After cancellation, the owner hard-stops a local child that has not confirmed by then. */
  readonly cancelConfirmBy?: string;
  /** Commands issued before the child reported `task.started`. */
  readonly pendingCommands?: readonly TaskCommand[];
  /** Sequence of the last applied `task.input` report for this generation. */
  readonly inputSeq?: number;
  /** One-line summary of an idle agent's last answer. */
  readonly lastStatus?: string;
  /**
   * Steering messages sent to an agent's current generation that the
   * agent has not yet reported receiving. Any still missing when it answers
   * start its next generation.
   */
  readonly steers?: number;
  /** Set when a workflow tool body started the current generation; its result goes to this reply hook. */
  readonly workflowCaller?: { readonly runId: string; readonly replyTo: string };
  /** The current generation's result reached history. */
  readonly delivered: boolean;
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
  readonly creator?: JsonObject;
  /** Reply hook of the `ctx.agent` call waiting on the task. */
  readonly replyTo?: string;
  readonly delivered?: boolean;
}

export type TaskRecordDecodeResult =
  | { readonly ok: true; readonly record: TaskRecord }
  | ({ readonly ok: false; readonly reason: string } & RecoveredTaskFields);

const KINDS = new Set<TaskKind>(["agent", "workflow"]);
const MODES = new Set<TaskMode>(["foreground", "background"]);
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
    case "message":
      return typeof value.message === "string" && isString(value.key);
    default:
      return false;
  }
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
  if (!isOptionalString(value.detachGroup)) return fail("invalid detachGroup");
  if (
    !isOptionalIsoTime(value.deadlineAt) ||
    !isOptionalIsoTime(value.clockStoppedAt) ||
    !isOptionalIsoTime(value.cancelConfirmBy)
  )
    return fail("invalid time");
  if (
    value.pendingCommands !== undefined &&
    (!Array.isArray(value.pendingCommands) || !value.pendingCommands.every(isTaskCommand))
  )
    return fail("invalid pendingCommands");
  if (
    value.inputSeq !== undefined &&
    (typeof value.inputSeq !== "number" || !Number.isSafeInteger(value.inputSeq))
  )
    return fail("invalid inputSeq");
  if (value.lastStatus !== undefined && typeof value.lastStatus !== "string")
    return fail("invalid lastStatus");
  if (
    value.steers !== undefined &&
    (typeof value.steers !== "number" || !Number.isSafeInteger(value.steers) || value.steers < 0)
  )
    return fail("invalid steers");
  if (
    value.workflowCaller !== undefined &&
    (!isRecordObject(value.workflowCaller) ||
      !isString(value.workflowCaller.runId) ||
      !isString(value.workflowCaller.replyTo))
  )
    return fail("invalid workflowCaller");
  if (typeof value.delivered !== "boolean") return fail("invalid delivered");
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
  if (isRecordObject(value.creator)) fields.creator = value.creator as JsonObject;
  if (isRecordObject(value.workflowCaller) && isString(value.workflowCaller.replyTo)) {
    fields.replyTo = value.workflowCaller.replyTo;
  }
  if (typeof value.delivered === "boolean") fields.delivered = value.delivered;
  return fields;
}
