import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionBundle } from "#execution/agent-sessions/context.js";
import type { AuthorizationResult, AuthorizationSignal } from "#harness/authorization.js";
import type { SandboxState } from "#sandbox/state.js";

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
  readonly sandbox: WorkflowStepSandbox;
}

/** Where `ctx.getSandbox()` finds the calling session's sandbox: its agent and sandbox key. */
export interface WorkflowStepSandbox {
  readonly bundle: AgentSessionBundle;
  /** The session that owns the sandbox the caller uses: its own, or the owner's it shares. */
  readonly sessionId: string;
  /** The caller's recorded sandbox state when the call was made, which the step resumes. */
  readonly state?: SandboxState;
}

export type WorkflowStepResult = { readonly authorized: readonly string[] } & (
  | { readonly kind: "result"; readonly output: unknown }
  | { readonly kind: "authorization-required"; readonly signal: AuthorizationSignal }
);

/** Compiler-owned envelope; contextIndexes marks arguments replaced with step-local context. */
export interface WorkflowStepInvocation {
  readonly args: readonly unknown[];
  readonly context: WorkflowStepContext;
  readonly contextIndexes: readonly number[];
}
