import type { Interaction } from "#protocol/session-reader.js";
import type { JsonValue } from "#shared/json.js";
import type { RequestStatus } from "#protocol/session-projection/request-status.js";

/** An interaction projected for JSON, without a sign-in's private callback URL. */
export type AgentInvocationInteraction = Omit<Interaction, "request"> & {
  readonly request: Omit<Interaction["request"], "signIn"> & {
    readonly signIn?: Omit<NonNullable<Interaction["request"]["signIn"]>, "callbackUrl">;
  };
};

/** Open interactions by `interactionId`. */
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
    })
  | (AgentInvocationBase & {
      readonly status: "awaiting-input";
      readonly interactions: AgentInvocationInteractions;
      /** Sign-ins complete elsewhere; polling observes their settlement. */
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

export type AgentInvocationStatus = RequestStatus;

export type AgentInvocationMutationResult =
  | { readonly type: "success"; readonly invocation: AgentInvocation }
  | { readonly type: "conflict"; readonly message: string }
  | { readonly type: "not_found" };
