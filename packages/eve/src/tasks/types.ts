import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
} from "#channel/types.js";
import type { WorkflowToolAgentRequest } from "#execution/tools/workflow/messages.js";
import { jsonValuesEqual, type JsonValue } from "#shared/json.js";
import type { TaskExecutorBinding } from "#tools/task.js";

/** Durable lifecycle status for one unit of background work. */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** Executor-neutral identity shown for one task. */
export interface TaskMetadata {
  readonly kind: string;
  readonly name: string;
  readonly [key: string]: JsonValue | undefined;
}

export function sameTaskMetadata(left: TaskMetadata, right: TaskMetadata): boolean {
  return jsonValuesEqual(left, right);
}

export type TaskOutput =
  | { readonly type: "result"; readonly data: JsonValue }
  | { readonly type: "error"; readonly data: JsonValue };

/** An outstanding request carried opaquely by the task lifecycle. */
export type TaskInputRequest = JsonValue;

export interface TaskUsage {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Reads valid provider usage without making task settlement depend on it. */
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

/** Reads the request identity from one opaque request. */
export function readTaskInputRequestId(request: TaskInputRequest): string | undefined {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return undefined;
  const requestId = Reflect.get(request, "requestId");
  return typeof requestId === "string" ? requestId : undefined;
}

interface TaskViewBase {
  readonly taskId: string;
  readonly metadata: TaskMetadata;
  /** Private executor state, excluded from model-visible JSON. */
  readonly executor?: { readonly binding?: TaskExecutorBinding };
  /** Retained for accounting, excluded from model-visible JSON. */
  readonly usage?: TaskUsage;
}

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

/** Executor-neutral commands accepted by the durable task run. */
export type TaskCommand =
  | { readonly executor: TaskExecutorBinding; readonly kind: "bind" }
  | {
      readonly kind: "complete";
      readonly data: JsonValue;
      readonly usage?: TaskUsage;
    }
  | {
      readonly kind: "fail";
      readonly data: JsonValue;
      readonly usage?: TaskUsage;
    }
  | { readonly kind: "reject-dispatch"; readonly data: JsonValue }
  | {
      readonly kind: "cancel";
      readonly usage?: TaskUsage;
    }
  | { readonly kind: "require-input"; readonly inputRequests: readonly TaskInputRequest[] }
  | { readonly kind: "ready" }
  | { readonly kind: "answered"; readonly requestIds: readonly string[] };

export interface TaskCommandHookPayload {
  readonly kind: "task-command";
  readonly command: TaskCommand;
}

/** Intermediate progress reported by an executor. */
export interface TaskInboundUpdate {
  readonly callId: string;
  readonly updateIndex: number;
  readonly updateEpoch: string;
  readonly kind: "task-update";
  readonly message: string;
}

/** One workflow-executor request bound to its private answer hook. */
export interface TaskInboundInputRequest {
  readonly kind: "task-input-request";
  readonly replyTo: string;
  readonly requests: readonly TaskInputRequest[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** One human answer routed through the task that owns the blocked executor. */
export interface TaskInboundAnswerInput {
  readonly auth?: unknown;
  readonly childContinuationToken: string;
  readonly childResponseUrl?: string;
  readonly inputResponses: readonly {
    readonly optionId?: string;
    readonly requestId: string;
    readonly text?: string;
  }[];
  readonly kind: "input-response";
  readonly taskId: string;
}

export type TaskRunInboundPayload =
  | TaskCommandHookPayload
  | TaskInboundAnswerInput
  | TaskInboundUpdate;

/** Generic task-owned request sent through the parent session payload. */
interface TaskInputRequestDeliveryBase {
  readonly replyTo: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly taskId: string;
  readonly turnId: string;
}

export type TaskInputRequestDelivery = TaskInputRequestDeliveryBase &
  (
    | { readonly request: TaskInputRequest; readonly requests?: never }
    | { readonly request?: never; readonly requests: readonly TaskInputRequest[] }
  );

/**
 * Child authorization event projected through the parent channel. Display
 * only: the authorization callback completes against the child directly.
 */
export interface TaskAuthorizationEventDelivery {
  readonly hookPayload: SubagentAuthorizationEventHookPayload;
  readonly taskId: string;
}

const TASK_AUTHORIZATION_REQUEST_ID_PREFIX = "task:authorization";

/** Stable id shared by one authorization attempt's events, used to dedupe deliveries. */
export function taskAuthorizationRequestId(event: SubagentAuthorizationEvent): string {
  if (event.type === "approval.candidate" || event.type === "approval.settled") {
    return `${TASK_AUTHORIZATION_REQUEST_ID_PREFIX}:${event.data.requestId}`;
  }
  return `${TASK_AUTHORIZATION_REQUEST_ID_PREFIX}:${event.data.attemptId ?? event.data.name}`;
}

/**
 * Agent spawn or settlement a task-owned workflow tool run asks its parent to
 * apply, forwarded after task admission. `replyTo` is the run's reply hook.
 */
export interface TaskAgentRequestDelivery {
  /** Outer action whose workflow body issued this request. */
  readonly actionCallId?: string;
  readonly replyTo: string;
  readonly request: WorkflowToolAgentRequest;
  readonly taskId: string;
}

export const TASK_VIEW_STREAM_NAMESPACE = "eve.task";

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isReadyTaskStatus(status: TaskStatus): boolean {
  return status === "input_required" || isTerminalTaskStatus(status);
}
