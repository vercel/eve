import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

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

/** Child or timer → owner inbox. The table applies the first terminal outcome of each generation. */
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
      /** Steering messages the child received for this generation before it answered. */
      readonly steers?: number;
    }
  | {
      /** Signals that a deadline or cancellation confirmation window may have passed. */
      readonly kind: "task.deadline";
      /**
       * The owner run that armed the timer. With `wakeAt`, it identifies the
       * armed timer's own signal; any other signal is still re-evaluated.
       */
      readonly ownerRunId: string;
      /** The wake time the timer was armed for. */
      readonly wakeAt: string;
    };

/** The owner timer's signal; it carries no task identity and is re-evaluated against the table. */
export type TaskDeadlineSignal = Extract<TaskMessage, { readonly kind: "task.deadline" }>;

/** Owner → child. Held on the record until the child reports `task.started`. */
export type TaskCommand =
  | { readonly kind: "cancel" }
  | { readonly kind: "answer"; readonly responses: readonly InputResponse[] }
  | {
      /**
       * A steering message that joins the current generation. It never changes
       * the generation's output schema, which belongs to the call that started it.
       */
      readonly kind: "message";
      readonly message: string;
      /** Idempotency key, from the steering call's turn and call IDs. */
      readonly key: string;
    };

/**
 * A child's report that settles a delegated call, with the steering messages
 * the child received for the call since it last answered it. The count
 * travels with the report but stays out of the public result type.
 */
export type ChildTaskReport = RuntimeSubagentChildResult & { readonly steers?: number };

/** The steering messages a child reported receiving, when its report carries a valid count. */
export function reportedSteers(result: RuntimeSubagentChildResult): number | undefined {
  const steers = (result as ChildTaskReport).steers;
  return typeof steers === "number" && Number.isSafeInteger(steers) && steers > 0
    ? steers
    : undefined;
}

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
}
