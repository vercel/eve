import type { JsonValue } from "#shared/json.js";
import type { TaskExecutorBinding } from "#shared/tool-task.js";
import type { SubagentAuthorizationEvent } from "#channel/types.js";

/**
 * Task lifecycle contract for `experimental.tasks`.
 *
 * A task is one durable unit of delegated work owned by a parent session.
 * The durable task run is the single writer for lifecycle transitions
 * (see `#execution/tasks/child/workflow.js`); every other path submits
 * commands and reads views. This module is dependency-free on
 * purpose: it is bundled into workflow bodies, which reject Node.js
 * builtins and heavyweight validators.
 */

/**
 * Task lifecycle status.
 *
 * `completed`, `failed`, and `cancelled` are terminal and final.
 * `input_required` is not terminal but is ready for parent action; the
 * child must wake its parent rather than deadlock while waiting for input.
 */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/**
 * Immutable identity of the delegated work behind a task.
 *
 * `agentId` is parent-controlled and exists before the child acknowledges its
 * private address, so the durable task can bind to persistent identity before
 * the dispatch side effect runs.
 */
export interface TaskMetadata {
  /** Stable model-visible identity of the persistent child session. */
  readonly agentId: string;
  readonly kind: "subagent";
  readonly mode: "local" | "remote";
  /** Authored subagent name the parent dispatched. */
  readonly name: string;
}

export type SubagentTaskMetadata = TaskMetadata;

/** Executor-neutral metadata retained by a non-subagent durable task. */
export interface BackgroundTaskMetadata {
  readonly kind: string;
  readonly name: string;
}

export type DurableTaskMetadata = BackgroundTaskMetadata | TaskMetadata;

export function createSubagentTaskMetadata(
  metadata: Omit<SubagentTaskMetadata, "kind" | "name"> & { readonly name: string },
): SubagentTaskMetadata {
  return { ...metadata, kind: "subagent" };
}

export function readSubagentTaskMetadata(task: {
  readonly executor?: TaskExecutorBinding | TaskExecutorState;
  readonly metadata: DurableTaskMetadata;
}): SubagentTaskMetadata | undefined {
  if (task.metadata.kind === "subagent" && "agentId" in task.metadata) {
    return task.metadata;
  }
  const executor = task.executor;
  const binding = executor !== undefined && "kind" in executor ? executor : executor?.binding;
  if (binding?.kind !== "subagent") return undefined;
  const agentId = binding.data.agentId;
  const mode = binding.data.mode;
  const name = binding.data.name;
  return typeof agentId === "string" &&
    (mode === "local" || mode === "remote") &&
    typeof name === "string"
    ? { agentId, kind: "subagent", mode, name }
    : undefined;
}

export function sameTaskMetadata(left: DurableTaskMetadata, right: DurableTaskMetadata): boolean {
  if (left.kind !== right.kind || left.name !== right.name) return false;
  const leftSubagent = "agentId" in left;
  const rightSubagent = "agentId" in right;
  return (
    leftSubagent === rightSubagent &&
    (!leftSubagent ||
      !rightSubagent ||
      (left.agentId === right.agentId && left.mode === right.mode))
  );
}

/** Private executor state retained for cancellation and address reconciliation. */
export interface TaskExecutorState {
  /** Write-once executor address recorded by the `bind` command. */
  readonly binding?: TaskExecutorBinding;
  readonly childSessionId?: string;
  readonly childTurnId?: string;
  /**
   * Child-session verdict from the last settled turn: `parked` survived
   * and can take another delivery, `terminal` ended with the turn.
   */
  readonly lifecycle?: "parked" | "terminal";
}

/**
 * Terminal task output. Failure is the state (`failed`); the `error`
 * output is its consequence — a `failed` task always carries one.
 * This intentionally diverges from MCP, which reserves `failed` for
 * protocol-level errors.
 */
export type TaskOutput =
  | { readonly type: "result"; readonly data: JsonValue }
  | { readonly type: "error"; readonly data: JsonValue };

/**
 * One outstanding request forwarded from a blocked child. Carried
 * opaquely: the task layer routes the batch, the input contract owns
 * its shape.
 */
export type TaskInputRequest = JsonValue;

/**
 * Provider token usage a child turn reported. Structural on purpose: it
 * mirrors `TokenUsage` (#shared/token-usage.js) without importing its
 * zod-backed module into a workflow-bundled file.
 */
export interface TaskUsage {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Validates one wire-carried usage value into {@link TaskUsage}.
 * Anything malformed is dropped rather than rejected: retention is
 * best-effort and must never fail a lifecycle transition.
 */
export function readTaskUsage(value: unknown): TaskUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cacheReadTokens = readUsageAxis(value, "cacheReadTokens");
  const cacheWriteTokens = readUsageAxis(value, "cacheWriteTokens");
  const inputTokens = readUsageAxis(value, "inputTokens");
  const outputTokens = readUsageAxis(value, "outputTokens");
  if (
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined
  ) {
    return undefined;
  }
  return { cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens };
}

function readUsageAxis(value: object, key: string): number | undefined {
  const field = Reflect.get(value, key);
  return typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
}

/**
 * One human answer to an outstanding request. Structural on purpose: it
 * mirrors the input contract's `InputResponse` without importing its
 * zod-backed module into a workflow-bundled file.
 */
export interface TaskInputResponse {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
}

/**
 * Request id of the synthetic entry that blocks a task while its child
 * waits for authorization. Giving the block an id keeps its release
 * bound to the same entry, so completing authorization can never clear
 * an unrelated request batch the child raised in the meantime.
 */
const TASK_AUTHORIZATION_REQUEST_ID_PREFIX = "task:authorization";

/** Stable task blocker id shared by one authorization attempt's events. */
export function taskAuthorizationRequestId(event: SubagentAuthorizationEvent): string {
  if (event.type === "approval.candidate" || event.type === "approval.settled") {
    return `${TASK_AUTHORIZATION_REQUEST_ID_PREFIX}:${event.data.requestId}`;
  }
  return `${TASK_AUTHORIZATION_REQUEST_ID_PREFIX}:${event.data.attemptId ?? event.data.name}`;
}

/** Reads the `requestId` of one opaque outstanding request. */
export function readTaskInputRequestId(request: TaskInputRequest): string | undefined {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return undefined;
  const requestId = Reflect.get(request, "requestId");
  return typeof requestId === "string" ? requestId : undefined;
}

/** Fields shared by every durable task view. */
interface TaskViewBase {
  readonly taskId: string;
  readonly metadata: DurableTaskMetadata;
  /** Private executor state; deliberately excluded from model-visible JSON. */
  readonly executor?: TaskExecutorState;
  /**
   * Provider usage the child reported at settlement; present when the
   * terminal command carried it. Retained for later accounting only —
   * budgets stay best-effort until a reservation model lands — and
   * deliberately excluded from model-visible task views (tasks/json.ts).
   */
  readonly usage?: TaskUsage;
}

/**
 * Full durable task view discriminated by lifecycle status.
 *
 * The task run appends one per accepted command; readers always observe a
 * complete view, never a delta. A view never contains routing credentials,
 * continuation tokens, or authorization capabilities.
 *
 * Completed and failed tasks carry their corresponding output, cancelled
 * tasks carry no output, and only input-required tasks carry requests.
 */
export type TaskView = TaskViewBase &
  (
    | {
        readonly status: "working";
        readonly inputRequests?: never;
        readonly lastOutput?: never;
      }
    | {
        readonly status: "input_required";
        readonly inputRequests: readonly TaskInputRequest[];
        readonly lastOutput?: never;
      }
    | {
        readonly status: "completed";
        readonly inputRequests?: never;
        readonly lastOutput: Extract<TaskOutput, { type: "result" }>;
      }
    | {
        readonly status: "failed";
        readonly inputRequests?: never;
        readonly lastOutput: Extract<TaskOutput, { type: "error" }>;
      }
    | {
        readonly status: "cancelled";
        readonly inputRequests?: never;
        readonly lastOutput?: never;
      }
  );

/** Commands accepted by the durable task run's transition function. */
export type TaskCommand =
  | {
      readonly executor: TaskExecutorBinding;
      readonly kind: "bind";
    }
  | {
      readonly kind: "complete";
      readonly data: JsonValue;
      readonly lifecycle?: "parked" | "terminal";
      readonly usage?: TaskUsage;
    }
  | {
      readonly kind: "fail";
      readonly data: JsonValue;
      readonly lifecycle?: "parked" | "terminal";
      readonly usage?: TaskUsage;
    }
  /** Terminal dispatch rejection for a task that was never indexed by its parent. */
  | {
      readonly kind: "reject-dispatch";
      readonly data: JsonValue;
      readonly lifecycle?: never;
      readonly usage?: never;
    }
  | {
      readonly kind: "cancel";
      readonly lifecycle?: "parked" | "terminal";
      readonly usage?: TaskUsage;
    }
  /** Retains a late executor settlement without changing task terminal status. */
  | { readonly kind: "settle-executor"; readonly usage?: TaskUsage }
  | { readonly kind: "require-authorization"; readonly requestId: string }
  | { readonly kind: "require-input"; readonly inputRequests: readonly TaskInputRequest[] }
  | { readonly kind: "ready" }
  /**
   * Clears the listed requests from the outstanding batch. Bound to
   * ids rather than unbound like the former `resume`, so an answer can
   * only ever release the batch it was written against.
   */
  | { readonly kind: "answered"; readonly requestIds: readonly string[] }
  | {
      readonly kind: "start-turn";
      readonly childSessionId: string;
      readonly childTurnId: string;
      readonly taskId: string;
    };

/** Hook payload envelope commanding a durable task run. */
export interface TaskCommandHookPayload {
  readonly kind: "task-command";
  readonly command: TaskCommand;
}

/**
 * Structural shapes of the child wire payloads a task run consumes.
 *
 * These mirror the existing parent-notification contracts (the local
 * `notifyDelegatedParentStep`, the subagent adapter's HITL forwarding,
 * and the remote callback route) without importing their zod-backed
 * modules: this file is bundled into workflow bodies. The wire itself
 * is unchanged — delegated dispatch only points it at the task run's
 * hook instead of the parent turn's inbox.
 */
export interface TaskInboundChildResult {
  readonly kind: "runtime-action-result";
  readonly results: readonly {
    readonly isError?: boolean;
    readonly outcome?: {
      readonly kind: "parked" | "terminal";
      readonly result:
        | { readonly kind: "succeeded"; readonly output: JsonValue }
        | { readonly error: JsonValue; readonly kind: "failed" }
        | { readonly kind: "cancelled" };
      /**
       * Provider usage this turn added. Retained on the terminal task
       * view ({@link TaskView.usage}); folding it into parent
       * budgets is deferred until a reservation model lands.
       */
      readonly usageDelta?: unknown;
    };
    readonly output: JsonValue;
  }[];
}

/**
 * Arrives when the delegated child emits `input.requested`. After dispatch is
 * acknowledged, the task run exposes the batch in an `input_required`
 * view and forwards the request to the parent session.
 */
export interface TaskInboundInputRequest {
  readonly callId: string;
  readonly childContinuationToken: string;
  readonly childSessionId: string;
  readonly kind: "subagent-input-request";
  readonly event: {
    readonly requests: readonly TaskInputRequest[];
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly subagentName: string;
}

/**
 * Arrives when a delegated child turn starts and its session and turn ids are
 * known. The task run records those ids for executor addressing; this payload
 * does not itself make the task ready or wake the parent.
 */
export interface TaskInboundTurnStarted {
  readonly childSessionId: string;
  readonly childTurnId: string;
  readonly kind: "turn-started";
  readonly taskId: string;
}

/** Intermediate progress sent by a running child to its parent agent. */
export interface TaskInboundUpdate {
  readonly callId: string;
  readonly childStepIndex: number;
  readonly childTurnId: string;
  readonly kind: "task-update";
  readonly message: string;
}

/**
 * Arrives when the delegated child emits `authorization.required` or
 * `authorization.completed`. The former exposes an authorization blocker in
 * the task view; the latter clears it. The event is forwarded separately
 * to the parent and is never copied into the view.
 */
export interface TaskInboundAuthorizationEvent {
  readonly callId: string;
  readonly childSessionId: string;
  readonly kind: "authorization-event";
  readonly event: SubagentAuthorizationEvent;
  readonly subagentName: string;
}

/**
 * Human answers routed to the task run rather than straight to the
 * child. The run owns both the delivery and the state change, so the
 * batch it clears is exactly the batch it forwarded — the parent can no
 * longer unblock the child while the run still believes it is blocked.
 */
export interface TaskInboundAnswerInput {
  readonly auth?: unknown;
  readonly childContinuationToken: string;
  readonly childResponseUrl?: string;
  readonly inputResponses: readonly TaskInputResponse[];
  readonly kind: "input-response";
  readonly taskId: string;
}

/** Everything a task run's inbound continuation hook may receive. */
export type TaskRunInboundPayload =
  | TaskCommandHookPayload
  | TaskInboundChildResult
  | TaskInboundInputRequest
  | TaskInboundTurnStarted
  | TaskInboundUpdate
  | TaskInboundAuthorizationEvent
  | TaskInboundAnswerInput;

/** Namespaced run stream carrying appended `TaskView` records. */
export const TASK_VIEW_STREAM_NAMESPACE = "eve.task";

/** True when the status can never change again. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** True when a transition into this status should wake the parent. */
export function isReadyTaskStatus(status: TaskStatus): boolean {
  return status === "input_required" || isTerminalTaskStatus(status);
}
