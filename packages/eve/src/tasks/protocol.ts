import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Version of the owner/child wire protocol. A child rejects a start with another version. */
export const TASK_PROTOCOL_VERSION = 1;

export type TaskKind = "agent" | "workflow";

/** Whether the owner's turn waits for the result (`foreground`) or not (`background`). */
export type TaskMode = "foreground" | "background";

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type TerminalTaskStatus = Extract<TaskStatus, "completed" | "failed" | "cancelled">;

/** Error codes a task can settle with. Consumers must handle unknown codes. */
export type TaskErrorCode =
  | "EXECUTION_FAILED"
  | "START_FAILED"
  | "TIMED_OUT"
  | "EMPTY_RESULT"
  | "OUTPUT_SCHEMA_NOT_FULFILLED"
  | "AGENT_SESSION_ENDED"
  | "STATE_LOST"
  | (string & {});

export interface TaskError {
  readonly code: TaskErrorCode;
  readonly message: string;
}

export type TaskOutcome =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: TaskError }
  | { readonly status: "cancelled" };

/** Where the owner reaches a started child. */
export type ChildAddress =
  | {
      /** A workflow tool run. `commandToken` is the run's command hook. */
      readonly kind: "workflow";
      readonly runId: string;
      readonly commandToken: string;
    }
  | {
      /** A local agent session, including a copy of the root agent. */
      readonly kind: "local";
      readonly sessionId: string;
      readonly continuationToken: string;
    }
  | {
      /** An agent session on another deployment. */
      readonly kind: "remote";
      readonly sessionId: string;
      readonly url: string;
      readonly callbackBaseUrl: string;
      readonly credentialResolver?: string;
    };

/** Child or timer → owner inbox. Deduplicated by {@link taskMessageKey}. */
export type TaskMessage =
  | {
      readonly kind: "task.started";
      readonly taskId: string;
      readonly generation: number;
      readonly child: ChildAddress;
    }
  | {
      readonly kind: "task.input";
      readonly taskId: string;
      readonly generation: number;
      /** Sequence of this report within the generation; later reports supersede earlier ones. */
      readonly seq: number;
      /** Requests still unanswered. An empty list means every request was resolved. */
      readonly requests: readonly InputRequest[];
    }
  | {
      readonly kind: "task.settled";
      readonly taskId: string;
      readonly generation: number;
      readonly outcome: TaskOutcome;
      readonly usage?: TokenUsage;
      /** The child session ended with this generation, so the agent cannot be given more work. */
      readonly childEnded?: boolean;
    }
  | {
      /** Signals that a deadline or cancellation confirmation window may have passed. */
      readonly kind: "task.deadline";
      readonly ownerRunId: string;
    };

/** Owner → child. Held on the record until the child reports `task.started`. */
export type TaskCommand =
  | { readonly kind: "cancel" }
  | { readonly kind: "answer"; readonly responses: readonly InputResponse[] }
  | { readonly kind: "message"; readonly message: string; readonly outputSchema?: JsonObject };

const TASK_MESSAGE_KINDS = new Set(["task.started", "task.input", "task.settled", "task.deadline"]);

/** Whether an inbox payload belongs to the task protocol. */
export function isTaskMessage(value: unknown): value is TaskMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && TASK_MESSAGE_KINDS.has(kind);
}

/**
 * Idempotency key for one message. `task.deadline` has no key: timers are
 * re-armed freely and every signal is re-evaluated against the table.
 */
export function taskMessageKey(message: TaskMessage): string | undefined {
  switch (message.kind) {
    case "task.started":
    case "task.settled":
      return JSON.stringify([message.taskId, message.generation, message.kind]);
    case "task.input":
      return JSON.stringify([message.taskId, message.generation, message.kind, message.seq]);
    case "task.deadline":
      return undefined;
  }
}

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
}
