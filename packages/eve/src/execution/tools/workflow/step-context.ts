import type { SessionContext } from "#context/session-context.js";
import type { AuthorizationResult, AuthorizationSignal } from "#harness/authorization.js";

export type WorkflowStepAuthorizationResult = AuthorizationResult & {
  readonly attemptId: string;
  readonly name: string;
};

export interface WorkflowStepContext {
  readonly callId: string;
  readonly toolName: string;
  readonly session: SessionContext["session"];
  readonly abortSignal: AbortSignal;
  readonly baseUrl: string;
  readonly token: string;
  readonly authorizationResults: readonly WorkflowStepAuthorizationResult[];
}

/**
 * A `retryable: false` authorization failure, returned rather than thrown: a thrown error
 * reaches the workflow body without the `reason`, `retryable` and sign-in the session records.
 */
export interface WorkflowStepFailure {
  readonly connectionName: string;
  readonly message: string;
  readonly reason?: string;
  /** The sign-in whose completion or token raised the failure. */
  readonly signIn?: string;
}

export type WorkflowStepResult = { readonly authorized: readonly string[] } & (
  | ({ readonly kind: "result" } & (
      | { readonly output: unknown; readonly failure?: never }
      | { readonly failure: WorkflowStepFailure; readonly output?: never }
    ))
  | { readonly kind: "authorization-required"; readonly signal: AuthorizationSignal }
);

/** Compiler-owned envelope; contextIndexes marks arguments replaced with step-local context. */
export interface WorkflowStepInvocation {
  readonly args: readonly unknown[];
  readonly context: WorkflowStepContext;
  readonly contextIndexes: readonly number[];
}
