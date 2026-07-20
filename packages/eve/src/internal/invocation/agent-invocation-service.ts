import type { SessionAuthContext } from "#channel/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";

export type AgentInvocationStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentInvocation {
  readonly invocationId: string;
  readonly revision: number;
  readonly status: AgentInvocationStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly pollAfterMs?: number;
  readonly inputRequests?: Readonly<Record<string, InputRequest>>;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface AgentInvocationSnapshot {
  readonly createdAt: string;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly invocationId: string;
  readonly ownerFingerprint: string;
  readonly revision: number;
}

export interface AgentInvocationRepository {
  create(input: {
    readonly auth: SessionAuthContext;
    readonly idempotencyKeyHash?: string;
    readonly message: string;
    readonly outputSchema?: JsonObject;
    readonly ownerFingerprint: string;
  }): Promise<AgentInvocationSnapshot>;
  findByIdempotencyKey(input: {
    readonly idempotencyKeyHash: string;
    readonly ownerFingerprint: string;
  }): Promise<AgentInvocationSnapshot | undefined>;
  read(invocationId: string): Promise<AgentInvocationSnapshot | undefined>;
  update(invocationId: string, responses: readonly InputResponse[]): Promise<void>;
  cancel(invocationId: string): Promise<void>;
}

export interface CreateAgentInvocationInput {
  readonly auth: SessionAuthContext;
  readonly message: string;
  readonly idempotencyKey?: string;
  readonly outputSchema?: JsonObject;
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
  readonly #repository: AgentInvocationRepository;
  readonly #maxWaitMs: number;

  constructor(
    repository: AgentInvocationRepository,
    options: { readonly maxWaitMs?: number } = {},
  ) {
    this.#repository = repository;
    this.#maxWaitMs = Math.min(Math.max(options.maxWaitMs ?? 25_000, 0), 30_000);
  }

  async create(input: CreateAgentInvocationInput): Promise<AgentInvocation> {
    const ownerFingerprint = await fingerprintAuth(input.auth);
    const idempotencyKeyHash =
      input.idempotencyKey === undefined
        ? undefined
        : await hashText(`${ownerFingerprint}\0${input.idempotencyKey}`);
    const existing =
      idempotencyKeyHash === undefined
        ? undefined
        : await this.#repository.findByIdempotencyKey({ idempotencyKeyHash, ownerFingerprint });
    const snapshot =
      existing ??
      (await this.#repository.create({
        auth: input.auth,
        idempotencyKeyHash,
        message: input.message,
        outputSchema: input.outputSchema,
        ownerFingerprint,
      }));
    return projectInvocation(snapshot);
  }

  async read(input: {
    readonly auth: SessionAuthContext;
    readonly invocationId: string;
    readonly afterRevision?: number;
    readonly waitMs?: number;
  }): Promise<AgentInvocation> {
    const ownerFingerprint = await fingerprintAuth(input.auth);
    const deadline = Date.now() + Math.min(Math.max(input.waitMs ?? 0, 0), this.#maxWaitMs);
    let polling = true;
    while (polling) {
      const snapshot = await this.#readOwned(input.invocationId, ownerFingerprint);
      if (input.afterRevision === undefined || snapshot.revision !== input.afterRevision) {
        return projectInvocation(snapshot);
      }
      if (Date.now() >= deadline) return projectInvocation(snapshot);
      await delay(Math.min(250, deadline - Date.now()));
      polling = Date.now() < deadline;
    }
    return projectInvocation(await this.#readOwned(input.invocationId, ownerFingerprint));
  }

  async update(input: {
    readonly auth: SessionAuthContext;
    readonly invocationId: string;
    readonly responses: readonly InputResponse[];
  }): Promise<AgentInvocation> {
    const ownerFingerprint = await fingerprintAuth(input.auth);
    const current = projectInvocation(await this.#readOwned(input.invocationId, ownerFingerprint));
    if (current.status !== "input_required") {
      if (current.status === "working") {
        throw new AgentInvocationConflictError("Invocation is not waiting for input.");
      }
      return current;
    }
    const pending = current.inputRequests ?? {};
    for (const response of input.responses) {
      if (pending[response.requestId] === undefined) {
        throw new AgentInvocationConflictError(`Unknown input request: ${response.requestId}`);
      }
    }
    await this.#repository.update(input.invocationId, input.responses);
    return await this.read({ auth: input.auth, invocationId: input.invocationId });
  }

  async cancel(input: {
    readonly auth: SessionAuthContext;
    readonly invocationId: string;
  }): Promise<AgentInvocation> {
    const ownerFingerprint = await fingerprintAuth(input.auth);
    const current = projectInvocation(await this.#readOwned(input.invocationId, ownerFingerprint));
    if (isTerminal(current.status)) return current;
    await this.#repository.cancel(input.invocationId);
    return await this.read(input);
  }

  async #readOwned(
    invocationId: string,
    ownerFingerprint: string,
  ): Promise<AgentInvocationSnapshot> {
    const snapshot = await this.#repository.read(invocationId);
    if (snapshot === undefined || !constantTimeEqual(snapshot.ownerFingerprint, ownerFingerprint)) {
      throw new AgentInvocationNotFoundError();
    }
    return snapshot;
  }
}

export function projectInvocation(snapshot: AgentInvocationSnapshot): AgentInvocation {
  let status: AgentInvocationStatus = "working";
  let result: unknown;
  let error: AgentInvocation["error"];
  let pending: Readonly<Record<string, InputRequest>> | undefined;
  let lastMessage: string | null | undefined;

  for (const event of snapshot.events) {
    switch (event.type) {
      case "input.requested":
        pending = Object.fromEntries(
          event.data.requests.map((request) => [request.requestId, request]),
        );
        status = "input_required";
        break;
      case "message.completed":
        if (event.data.message !== null) lastMessage = event.data.message;
        break;
      case "result.completed":
        result = event.data.result;
        break;
      case "turn.started":
        pending = undefined;
        status = "working";
        break;
      case "session.completed":
        status = "completed";
        result ??= lastMessage ?? "";
        break;
      case "session.failed":
        status = "failed";
        error = { code: -32603, data: event.data.details, message: event.data.message };
        break;
      case "turn.cancelled":
        status = "cancelled";
        break;
    }
  }

  const invocation: {
    createdAt: string;
    invocationId: string;
    revision: number;
    status: AgentInvocationStatus;
    pollAfterMs?: number;
    inputRequests?: Readonly<Record<string, InputRequest>>;
    result?: unknown;
    error?: AgentInvocation["error"];
  } = {
    createdAt: snapshot.createdAt,
    invocationId: snapshot.invocationId,
    pollAfterMs: status === "working" ? 1_000 : undefined,
    revision: snapshot.revision,
    status,
  };
  if (pending !== undefined) invocation.inputRequests = pending;
  if (result !== undefined) invocation.result = result;
  if (error !== undefined) invocation.error = error;
  return invocation;
}

export async function fingerprintAuth(auth: SessionAuthContext): Promise<string> {
  return await hashText(
    JSON.stringify({
      authenticator: auth.authenticator,
      issuer: auth.issuer ?? "",
      principalId: auth.principalId,
      principalType: auth.principalType,
      subject: auth.subject ?? "",
    }),
  );
}

function isTerminal(status: AgentInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index++)
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
