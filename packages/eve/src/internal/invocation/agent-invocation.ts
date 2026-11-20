import type { Interaction } from "#protocol/session-projection/reader.js";
import type { JsonValue } from "#shared/json.js";
import type { RequestStatus } from "#protocol/session-projection/request-status.js";

export type AgentInvocationInteraction = Omit<Interaction, "request"> & {
  readonly request: Omit<Interaction["request"], "signIn"> & {
    readonly signIn?: Omit<NonNullable<Interaction["request"]["signIn"]>, "callbackUrl">;
  };
};

export type AgentInvocationInteractions = Readonly<Record<string, AgentInvocationInteraction>>;

interface AgentInvocationBase {
  readonly sessionEnded: boolean;
  readonly invocationId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export type AgentInvocation =
  | (AgentInvocationBase & {
      readonly status: "working";
      readonly pollAfterMs: number;
      readonly result?: JsonValue;
      readonly statusMessage?: string;
    })
  | (AgentInvocationBase & {
      readonly status: "awaiting-input";
      readonly interactions: AgentInvocationInteractions;
      readonly pollAfterMs?: number;
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

export type AgentInvocationStatus = RequestStatus | "working";

export type AgentInvocationMutationResult =
  | { readonly type: "success"; readonly invocation: AgentInvocation }
  | { readonly type: "conflict"; readonly message: string }
  | { readonly type: "not_found" };
