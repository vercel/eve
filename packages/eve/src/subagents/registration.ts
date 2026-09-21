/** A session-local reference to an agent destination, independent of its current execution. */
export interface AgentReference {
  readonly id: string;
}

/** Register a compiled agent or a remote eve endpoint without starting a conversation. */
export interface AgentDestination {
  readonly key: string;
  readonly description: string;
  readonly target:
    | { readonly kind: "agent"; readonly name: string }
    | { readonly kind: "remote"; readonly url: string; readonly sessionId?: string };
}

/** Receipt for work accepted by the current session; completion follows the normal task flow. */
export interface AgentTaskReceipt {
  readonly agentId: string;
  readonly taskId: string;
  readonly status: "working";
}

export interface AgentRegistration extends AgentDestination {
  readonly visible: boolean;
}
