import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

/**
 * Version of the owner/child task protocol that crosses deployments. A remote
 * owner sends it with every delegated request; a child rejects any other
 * version, and an owner rejects a child that does not report this one. The
 * published task stream fixtures record it, so a change regenerates them.
 */
export const TASK_PROTOCOL_VERSION = 1;

/** The error code a child answers a delegated request from another protocol version with. */
export const TASK_PROTOCOL_MISMATCH = "TASK_PROTOCOL_MISMATCH";

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
      /**
       * Where this answer falls among the child's answers, which only grows.
       * An answer at or below the last one applied is a repeat of it.
       */
      readonly answer?: number;
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
 * the child received for the call since it last answered it, and the
 * answer's place among the child's answers. Both travel with the report but
 * stay out of the public result type.
 */
export type ChildTaskReport = RuntimeSubagentChildResult & {
  readonly steers?: number;
  readonly answer?: number;
};

/** The steering messages a child reported receiving, when its report carries a valid count. */
export function reportedSteers(result: RuntimeSubagentChildResult): number | undefined {
  const steers = (result as ChildTaskReport).steers;
  return typeof steers === "number" && Number.isSafeInteger(steers) && steers > 0
    ? steers
    : undefined;
}

/**
 * Orders a delegated session's answers to its callers, so a caller applies
 * each answer once and never mistakes an earlier one for a later one. The
 * session's turn sequence only grows, survives handoff, and advances with
 * every turn, so two parked answers never share it; a terminal report can
 * follow the last parked answer with no completed turn in between, so it
 * sorts after it.
 */
export function answerOrder(turnSequence: number, lifecycle: "parked" | "terminal"): number {
  return turnSequence * 2 + (lifecycle === "terminal" ? 1 : 0);
}

/** The ordering fields a child stamps on a report; zero steers are left out. */
export function reportOrdering(
  steers: number | undefined,
  answer: number | undefined,
): { answer?: number; steers?: number } {
  const ordering: { answer?: number; steers?: number } = {};
  if (steers !== undefined && steers !== 0) ordering.steers = steers;
  if (answer !== undefined) ordering.answer = answer;
  return ordering;
}

/** The place of a child's answer among its answers, when its report carries a valid one. */
export function reportedAnswer(result: RuntimeSubagentChildResult): number | undefined {
  const answer = (result as ChildTaskReport).answer;
  return typeof answer === "number" && Number.isSafeInteger(answer) && answer >= 0
    ? answer
    : undefined;
}

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
}
