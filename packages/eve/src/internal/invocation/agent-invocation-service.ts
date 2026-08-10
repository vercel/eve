import type { SessionAuthContext } from "#channel/types.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
export type AgentInvocationStatus =
  | "working"
  | "input_required"
  | "authorization_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentInvocationAuthorizationRequest {
  readonly authorization?: ConnectionAuthorizationChallenge;
  readonly description: string;
  readonly name: string;
  readonly webhookUrl?: string;
}

export interface AgentInvocation {
  readonly invocationId: string;
  readonly status: AgentInvocationStatus;
  readonly createdAt: string;
  readonly authorizations?: readonly AgentInvocationAuthorizationRequest[];
  readonly expiresAt?: string;
  readonly pollAfterMs?: number;
  readonly inputRequests?: Readonly<Record<string, InputRequest>>;
  readonly result?: JsonValue;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: JsonValue };
}

/** Result of attempting to update an invocation. */
export type AgentInvocationMutationResult =
  | { readonly type: "success"; readonly invocation: AgentInvocation }
  | { readonly type: "conflict"; readonly message: string }
  | { readonly type: "not_found" };

/** Execution layer interface for agent invocations. */
export interface AgentInvocationExecution {
  create(input: {
    readonly auth: SessionAuthContext | null;
    readonly message: string | import("ai").UserContent;
    readonly outputSchema?: JsonObject;
  }): Promise<AgentInvocation>;
  read(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined>;
  update(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
    readonly responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult>;
  cancel(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined>;
}

export interface CreateAgentInvocationInput {
  readonly auth: SessionAuthContext | null;
  readonly message: string | import("ai").UserContent;
  readonly outputSchema?: JsonObject;
}

export interface UpdateAgentInvocationInput {
  readonly auth: SessionAuthContext | null;
  readonly invocationId: string;
  readonly responses: readonly InputResponse[];
}

export class AgentInvocationNotFoundError extends Error {
  constructor() {
    super("Invocation not found.");
    this.name = "AgentInvocationNotFoundError";
  }
}

export class AgentInvocationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInvocationConflictError";
  }
}

/** Protocol-neutral durable agent invocation lifecycle. */
export class AgentInvocationService {
  readonly #execution: AgentInvocationExecution;

  constructor(execution: AgentInvocationExecution) {
    this.#execution = execution;
  }

  async create(input: CreateAgentInvocationInput): Promise<AgentInvocation> {
    return await this.#execution.create(input);
  }

  async read(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation> {
    const invocation = await this.#execution.read(input);
    if (invocation === undefined) {
      throw new AgentInvocationNotFoundError();
    }
    return invocation;
  }

  async update(input: UpdateAgentInvocationInput): Promise<AgentInvocation> {
    const result = await this.#execution.update(input);

    switch (result.type) {
      case "success":
        return result.invocation;
      case "conflict":
        throw new AgentInvocationConflictError(result.message);
      case "not_found":
        throw new AgentInvocationNotFoundError();
    }
  }

  async cancel(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation> {
    const result = await this.#execution.cancel(input);
    if (result === undefined) {
      throw new AgentInvocationNotFoundError();
    }
    return result;
  }
}
