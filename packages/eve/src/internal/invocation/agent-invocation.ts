import type { Interaction } from "#protocol/session-reader.js";
import type { JsonValue } from "#shared/json.js";

/** An interaction projected for JSON, without a sign-in's private callback URL. */
export type AgentInvocationInteraction = Omit<Interaction, "request"> & {
  readonly request: Omit<Interaction["request"], "signIn"> & {
    readonly signIn?: Omit<NonNullable<Interaction["request"]["signIn"]>, "callbackUrl">;
  };
};

/** Open interactions by `interactionId`. */
export type AgentInvocationInteractions = Readonly<Record<string, AgentInvocationInteraction>>;

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
      readonly interactions: AgentInvocationInteractions;
      readonly result?: JsonValue;
    })
  | (AgentInvocationBase & {
      readonly status: "authorization_required";
      /** The sign-ins the task waits on, which complete elsewhere: polling sees them end. */
      readonly interactions: AgentInvocationInteractions;
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
