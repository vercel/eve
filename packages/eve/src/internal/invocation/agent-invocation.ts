import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { JsonValue } from "#shared/json.js";

export interface AgentInvocationAuthorizationRequest {
  readonly authorization?: ConnectionAuthorizationChallenge;
  readonly description: string;
  readonly name: string;
  readonly webhookUrl?: string;
}

interface AgentInvocationBase {
  readonly invocationId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export type AgentInvocation =
  | (AgentInvocationBase & {
      readonly status: "working";
      readonly pollAfterMs: number;
      readonly result?: JsonValue;
    })
  | (AgentInvocationBase & {
      readonly status: "input_required";
      readonly inputRequests: Readonly<Record<string, InputRequest>>;
      readonly result?: JsonValue;
    })
  | (AgentInvocationBase & {
      readonly status: "authorization_required";
      readonly authorizations: readonly [
        AgentInvocationAuthorizationRequest,
        ...AgentInvocationAuthorizationRequest[],
      ];
      readonly pollAfterMs: number;
      readonly result?: JsonValue;
    })
  | (AgentInvocationBase & { readonly status: "completed"; readonly result?: JsonValue })
  | (AgentInvocationBase & {
      readonly status: "failed";
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: JsonValue;
      };
    })
  | (AgentInvocationBase & { readonly status: "cancelled" });

export type AgentInvocationStatus = AgentInvocation["status"];

export type AgentInvocationMutationResult =
  | { readonly type: "success"; readonly invocation: AgentInvocation }
  | { readonly type: "conflict"; readonly message: string }
  | { readonly type: "not_found" };
