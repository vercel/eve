import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import type { BackgroundToolCall } from "#harness/background-tools.js";
import type { HarnessSession } from "#harness/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const TASK_DELEGATED_KIND = "eve:task-delegated";

/** Private address an executor uses to report lifecycle changes to its owning task. */
export interface TaskBinding {
  readonly taskId: string;
  readonly token: string;
  readonly url?: string;
}

/**
 * Opaque, task-private address used to control an external executor. `data`
 * means nothing to the task layer beyond deep equality (replay idempotency);
 * only the executor `kind` that wrote it may parse it (e.g. cancel routing).
 */
export interface TaskExecutorBinding {
  readonly kind: string;
  readonly data: JsonObject;
}

/**
 * What the model sees as this call's tool output when work is delegated: the
 * author-supplied data plus `status: "working"` and the `taskId` it can poll
 * or cancel. It acknowledges delegation — it is not the task's result, which
 * arrives later through task completion.
 */
export type TaskReceipt<TData extends JsonObject = JsonObject> = TData & {
  readonly status: "working";
  readonly taskId: string;
};

/**
 * Sentinel returned by a background tool after an external executor accepts
 * responsibility for the task. Returning it ends `execute`; it does not
 * complete the durable task.
 */
export interface TaskDelegated<TData extends JsonObject = JsonObject> {
  readonly kind: typeof TASK_DELEGATED_KIND;
  readonly executor: TaskExecutorBinding;
  readonly receipt: TaskReceipt<TData>;
}

/**
 * Terminal commands an in-process executor may report to its task via
 * {@link TaskExec.send}. Deliberately narrower than the task run's full
 * command surface — bind, ready, and input routing stay runtime-owned.
 */
export type TaskSendCommand =
  | { readonly kind: "complete"; readonly data: JsonValue }
  | { readonly kind: "fail"; readonly data: JsonValue }
  | { readonly kind: "cancel" };

/** Task capability passed only to tools declared with `execution: "background"`. */
export interface TaskExec {
  /**
   * The sibling background calls admitted in the same step. The only view a
   * tool has of what launched alongside it, for enforcing batch-wide
   * invariants before delegating.
   */
  readonly batch: readonly BackgroundToolCall[];
  /**
   * The task-private address for reporting lifecycle changes back to this
   * task. Hand it to the external executor so completion routes to the task
   * directly instead of through the (already finished) tool call.
   */
  readonly binding: TaskBinding;
  /**
   * Snapshot of the harness session at step start, for reading context.
   * Mutating it changes nothing durable: session writes belong to the
   * runtime, keyed off the executor binding at step commit.
   */
  readonly session: HarnessSession;
  /**
   * Delivers a terminal command to this task's inbox from the same process,
   * for executors that outlive `execute` in-memory (e.g. a callback firing
   * after delegation). Call it only after `execute` returned `delegated(...)`
   * — the runtime settles non-delegated returns itself, and a second terminal
   * command is refused. Not restart-safe: an in-process callback dies with
   * the process; the persisted executor binding remains the durable
   * cancellation path. Throws when the task no longer accepts commands
   * (already terminal).
   */
  readonly send: (command: TaskSendCommand) => Promise<void>;
  /** The durable task backing this call; its identity outlives `execute`. */
  readonly task: BackgroundTask;

  /**
   * Builds the `TaskDelegated` sentinel to return from `execute`. Centralizes
   * receipt stamping so every receipt carries this task's `taskId` and
   * `status: "working"` — tools cannot mint receipts for tasks they don't own.
   */
  delegated<TData extends JsonObject>(input: {
    readonly executor: TaskExecutorBinding;
    readonly receipt: TData;
  }): TaskDelegated<TData>;
}

export function createTaskDelegated<TData extends JsonObject>(input: {
  readonly binding: TaskBinding;
  readonly executor: TaskExecutorBinding;
  readonly receipt: TData;
}): TaskDelegated<TData> {
  return {
    executor: input.executor,
    kind: TASK_DELEGATED_KIND,
    receipt: { ...input.receipt, status: "working", taskId: input.binding.taskId },
  };
}

export function isTaskDelegated(value: unknown): value is TaskDelegated {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === TASK_DELEGATED_KIND
  );
}
