import type { JsonValue } from "#shared/json.js";

/**
 * An open interaction as an invocation reports it, under its `interactionId`: what the person is
 * asked, the call it's about, and a sign-in's challenge. Its own shape, so the MCP contract
 * changes only when this does.
 */
export interface AgentInvocationInteraction {
  readonly kind: string;
  readonly prompt: string;
  readonly title?: string;
  readonly options?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly allowFreeform?: boolean;
  readonly display?: string;
  readonly call?: { readonly callId: string; readonly name: string; readonly input?: JsonValue };
  readonly signIn?: {
    readonly name: string;
    readonly displayName?: string;
    readonly url?: string;
    readonly userCode?: string;
    readonly expiresAt?: string;
    readonly instructions?: string;
    readonly callbackUrl?: string;
  };
}

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
