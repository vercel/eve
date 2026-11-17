import type { SessionContext } from "#context/session-context.js";
import type { InstrumentationChannel } from "#shared/instrumentation-channel.js";
import type { AgentSessionOwner } from "#execution/agent-sessions/owner.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
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
  readonly delegated: boolean;
  readonly channel: InstrumentationChannel;
}

export type WorkflowStepSandbox = AgentSessionOwner & {
  readonly sessionId: string;
  readonly state?: SandboxState;
};

export type WorkflowStepResult = { readonly authorized: readonly string[] } & (
  | { readonly kind: "result"; readonly output: unknown }
  | {
      readonly kind: "authorization-required";
      readonly challenges: readonly AuthorizationChallenge[];
    }
);

export interface WorkflowStepInvocation {
  readonly args: readonly unknown[];
  readonly context: WorkflowStepContext;
  readonly contextIndexes: readonly number[];
}
