import type { UserContent } from "ai";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import {
  INTERNAL_CHANNEL_DELIVER,
  type ChannelFrom,
  type InternalChannelSource,
} from "#channel/channel-operations.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import type {
  AgentInvocation,
  AgentInvocationAuthorizationRequest,
  AgentInvocationExecution,
  AgentInvocationMutationResult,
  AgentInvocationStatus,
} from "#internal/invocation/agent-invocation-service.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
  invocationUpdateRequestId,
} from "#internal/invocation/metadata.js";
import {
  INVOCATION_UPDATE_RECEIPT_ATTRIBUTE,
  invocationUpdateReceiptFromRequestId,
} from "#internal/invocation/attributes.js";
import type { RouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";

export class WorkflowAgentInvocationExecution implements AgentInvocationExecution {
  readonly #channelName: string;
  readonly #createSession: RouteSessionCreator;
  readonly #from: ChannelFrom;

  constructor(input: {
    readonly channelName: string;
    readonly createSession: RouteSessionCreator;
    readonly from: ChannelFrom;
  }) {
    this.#channelName = input.channelName;
    this.#createSession = input.createSession;
    this.#from = input.from;
  }

  async create(input: {
    readonly auth: SessionAuthContext | null;
    readonly message: string | UserContent;
    readonly outputSchema?: JsonObject;
  }): Promise<AgentInvocation> {
    const continuationToken = `invocation:${crypto.randomUUID()}`;
    const handle = await this.#createSession({
      auth: input.auth,
      capabilities: { requestInput: true },
      continuationToken: `${this.#channelName}:${continuationToken}`,
      externalInvocation: {
        continuationToken,
        ownerKey: invocationOwnerKey(input.auth),
      },
      input: { message: input.message, outputSchema: input.outputSchema },
      mode: "task",
    });

    const run = await this.#readInvocationRun(handle.sessionId, input.auth);
    if (run === undefined) {
      throw new Error("Invocation run was unavailable after durable creation.");
    }
    return workingInvocation(
      handle.sessionId,
      run.createdAt.toISOString(),
      run.expiredAt?.toISOString(),
    );
  }

  async read(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    const run = await this.#readInvocationRun(input.invocationId, input.auth);
    if (run === undefined) return undefined;

    if (isTerminalRunStatus(run.status)) {
      return await terminalInvocation(run);
    }
    const events = await readRecentPersistedEvents(input.invocationId);
    return projectNonterminal(
      run.runId,
      run.createdAt.toISOString(),
      run.expiredAt?.toISOString(),
      events,
    );
  }

  async update(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
    readonly responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult> {
    const updateRequestId = invocationUpdateRequestId(input.responses);
    const updateReceipt = invocationUpdateReceiptFromRequestId(updateRequestId);
    if (updateReceipt === undefined) throw new Error("Invocation update receipt was unavailable.");
    const current = await this.read(input);
    if (current === undefined) return { type: "not_found" };
    const run = await this.#readInvocationRun(input.invocationId, input.auth);
    if (run === undefined) return { type: "not_found" };
    if (run.attributes[INVOCATION_UPDATE_RECEIPT_ATTRIBUTE] === updateReceipt) {
      return { invocation: current, type: "success" };
    }
    if (current.status !== "input_required") {
      return conflict("Invocation is not waiting for input.");
    }
    for (const response of input.responses) {
      if (current.inputRequests?.[response.requestId] === undefined) {
        return conflict(`Unknown input request: ${response.requestId}`);
      }
    }

    const token = run.attributes[INVOCATION_TOKEN_ATTRIBUTE];
    if (token === undefined) return { type: "not_found" };
    try {
      const source = this.#from(token) as InternalChannelSource;
      await source[INTERNAL_CHANNEL_DELIVER](
        { inputResponses: input.responses },
        { auth: input.auth, requestId: updateRequestId },
      );
    } catch (error) {
      if (RunExpiredError.is(error)) return { type: "not_found" };
      const accepted = await this.#readInvocationRun(input.invocationId, input.auth);
      if (accepted?.attributes[INVOCATION_UPDATE_RECEIPT_ATTRIBUTE] === updateReceipt) {
        return {
          invocation: workingInvocation(input.invocationId, current.createdAt, current.expiresAt),
          type: "success",
        };
      }
      throw error;
    }

    return {
      invocation: workingInvocation(input.invocationId, current.createdAt, current.expiresAt),
      type: "success",
    };
  }

  async cancel(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    const current = await this.read(input);
    if (current === undefined || isTerminal(current.status)) return current;
    try {
      await getRun(input.invocationId).cancel();
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
    return await this.read(input);
  }

  async #readInvocationRun(invocationId: string, auth: SessionAuthContext | null) {
    const world = await getWorld();
    try {
      const run = await world.runs.get(invocationId);
      if (run.attributes[INVOCATION_TOKEN_ATTRIBUTE] === undefined) return undefined;
      return run.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(auth)
        ? run
        : undefined;
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
  }
}

const INVOCATION_EVENT_WINDOW_SIZE = 64;

async function readRecentPersistedEvents(
  invocationId: string,
): Promise<HandleMessageStreamEvent[]> {
  const readable = getRun(invocationId).getReadable<Uint8Array>({
    startIndex: -INVOCATION_EVENT_WINDOW_SIZE,
  });
  const tailIndex = await readable.getTailIndex();
  if (tailIndex < 0) {
    await readable.cancel("invocation event stream is empty").catch(() => {});
    return [];
  }
  const expectedEvents = Math.min(tailIndex + 1, INVOCATION_EVENT_WINDOW_SIZE);

  const reader = parseNdjsonStream<HandleMessageStreamEvent>(() => readable).getReader();
  const events: HandleMessageStreamEvent[] = [];
  try {
    while (events.length < expectedEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(value);
    }
  } finally {
    await reader.cancel("invocation event window read complete").catch(() => {});
    reader.releaseLock();
  }
  return events;
}

function projectNonterminal(
  invocationId: string,
  createdAt: string,
  expiresAt: string | undefined,
  events: readonly HandleMessageStreamEvent[],
): AgentInvocation {
  const authorizations = new Map<string, AgentInvocationAuthorizationRequest>();
  let inputRequests: Readonly<Record<string, InputRequest>> | undefined;
  let result: JsonValue | undefined;
  for (const event of events) {
    if (event.type === "input.requested") {
      inputRequests = Object.fromEntries(
        event.data.requests.map((request) => [request.requestId, request]),
      );
    } else if (event.type === "turn.started") {
      authorizations.clear();
      inputRequests = undefined;
      result = undefined;
    } else if (event.type === "authorization.required") {
      const authorization: {
        authorization?: AgentInvocationAuthorizationRequest["authorization"];
        description: string;
        name: string;
        webhookUrl?: string;
      } = {
        description: event.data.description,
        name: event.data.name,
      };
      if (event.data.authorization !== undefined) {
        authorization.authorization = event.data.authorization;
      }
      if (event.data.webhookUrl !== undefined) {
        authorization.webhookUrl = event.data.webhookUrl;
      }
      authorizations.set(event.data.name, authorization);
    } else if (event.type === "authorization.completed") {
      authorizations.delete(event.data.name);
    } else if (
      event.type === "message.completed" &&
      event.data.finishReason !== "tool-calls" &&
      event.data.message !== null
    ) {
      result = safeJson(event.data.message);
    }
  }
  const pendingAuthorizations = [...authorizations.values()];
  const status: "working" | "input_required" | "authorization_required" =
    pendingAuthorizations.length > 0
      ? "authorization_required"
      : inputRequests === undefined
        ? "working"
        : "input_required";
  return {
    authorizations: pendingAuthorizations.length > 0 ? pendingAuthorizations : undefined,
    createdAt,
    expiresAt,
    inputRequests,
    invocationId,
    pollAfterMs: status === "working" || status === "authorization_required" ? 1_000 : undefined,
    result,
    status,
  };
}

async function terminalInvocation(run: {
  readonly createdAt: Date;
  readonly error?: unknown;
  readonly expiredAt?: Date;
  readonly runId: string;
  readonly status: string;
}): Promise<AgentInvocation> {
  const base = {
    createdAt: run.createdAt.toISOString(),
    expiresAt: run.expiredAt?.toISOString(),
    invocationId: run.runId,
  };
  if (run.status === "cancelled") return { ...base, status: "cancelled" };
  if (run.status === "failed") {
    return {
      ...base,
      error: { code: -32603, data: safeJson(run.error), message: errorMessage(run.error) },
      status: "failed",
    };
  }
  const returned = await getRun<{ readonly output: unknown }>(run.runId).returnValue;
  return { ...base, result: safeJson(returned.output), status: "completed" };
}

function workingInvocation(
  invocationId: string,
  createdAt: string,
  expiresAt: string | undefined,
): AgentInvocation {
  return { createdAt, expiresAt, invocationId, pollAfterMs: 1_000, status: "working" };
}

function safeJson(value: unknown): JsonValue {
  try {
    return parseJsonValue(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Session failed.";
}

function conflict(message: string): AgentInvocationMutationResult {
  return { message, type: "conflict" };
}

function isTerminal(status: AgentInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
