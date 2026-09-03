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
  AgentInvocationMutationResult,
  AgentInvocationStatus,
} from "#internal/invocation/agent-invocation.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationInputRequestId,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";
import type { RouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent, InputResolution } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";

export class WorkflowAgentInvocationExecution {
  readonly #createSession: RouteSessionCreator;
  readonly #from: ChannelFrom;

  constructor(input: { readonly createSession: RouteSessionCreator; readonly from: ChannelFrom }) {
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
      continuationToken,
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
      const events =
        run.status === "failed" ? await readRecentPersistedEvents(input.invocationId) : [];
      return await terminalInvocation(run, events);
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
    const current = await this.read(input);
    if (current === undefined) return { type: "not_found" };
    if (current.status !== "input_required") {
      // A retry after a lost response is the common case here: the answer
      // already landed, so acknowledge it instead of demanding a new one.
      const events = await readRecentPersistedEvents(input.invocationId);
      if (replaysResolvedBatch(events, input.responses)) {
        return { invocation: current, type: "success" };
      }
      return conflict("Invocation is not waiting for input.");
    }
    const run = await this.#readInvocationRun(input.invocationId, input.auth);
    if (run === undefined) return { type: "not_found" };
    const pendingBatch = latestPendingInputBatch(
      await readRecentPersistedEvents(input.invocationId),
    );
    if (pendingBatch === undefined) {
      return conflict("Invocation input changed before the update could be applied.");
    }
    const responseIds = new Set<string>();
    const deliveredResponses: InputResponse[] = [];
    for (const response of input.responses) {
      const rawRequestId = pendingBatch.rawRequestIds[response.requestId];
      if (rawRequestId === undefined) {
        return conflict(`Unknown input request: ${response.requestId}`);
      }
      responseIds.add(response.requestId);
      deliveredResponses.push({ ...response, requestId: rawRequestId });
    }
    if (
      responseIds.size !== input.responses.length ||
      responseIds.size !== Object.keys(pendingBatch.requests).length
    ) {
      return conflict("Responses must answer the complete pending input batch exactly once.");
    }
    const token = run.attributes[INVOCATION_TOKEN_ATTRIBUTE];
    if (token === undefined) return { type: "not_found" };
    try {
      const source = this.#from(token) as InternalChannelSource;
      await source[INTERNAL_CHANNEL_DELIVER](
        { inputResponses: deliveredResponses },
        { auth: input.auth },
      );
    } catch (error) {
      if (RunExpiredError.is(error)) return { type: "not_found" };
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

interface PendingInputBatch {
  readonly id: string;
  readonly rawRequestIds: Readonly<Record<string, string>>;
  readonly requests: Readonly<Record<string, InputRequest>>;
}

function pendingInputBatch(
  event: Extract<HandleMessageStreamEvent, { type: "input.requested" }>,
): PendingInputBatch {
  const rawRequestIds: Record<string, string> = {};
  const requests: Record<string, InputRequest> = {};
  for (const request of event.data.requests) {
    const requestId = invocationInputRequestId(event.meta.id, request.requestId);
    rawRequestIds[requestId] = request.requestId;
    requests[requestId] = { ...request, requestId };
  }
  return { id: event.meta.id, rawRequestIds, requests };
}

/**
 * Removes resolved requests from a batch. The harness resolves a batch as a
 * whole today, but request-level bookkeeping keeps this correct if it ever
 * resolves them separately.
 */
function withoutResolved(
  batch: PendingInputBatch,
  resolutions: readonly InputResolution[],
): PendingInputBatch | undefined {
  const resolvedRawIds = new Set(resolutions.map((resolution) => resolution.requestId));
  const rawRequestIds: Record<string, string> = {};
  const requests: Record<string, InputRequest> = {};
  for (const [requestId, rawRequestId] of Object.entries(batch.rawRequestIds)) {
    if (resolvedRawIds.has(rawRequestId)) continue;
    rawRequestIds[requestId] = rawRequestId;
    const request = batch.requests[requestId];
    if (request !== undefined) requests[requestId] = request;
  }
  return Object.keys(rawRequestIds).length === 0
    ? undefined
    : { id: batch.id, rawRequestIds, requests };
}

interface ResolvedInputBatch {
  readonly batch: PendingInputBatch;
  readonly responses: ReadonlyMap<string, InputResponse | undefined>;
}

/**
 * Folds the event window into the currently pending batch and the most
 * recently resolved batch. Both are needed: the first to accept an answer,
 * the second to recognize a client re-sending an answer that already landed.
 */
function foldInputBatches(events: readonly HandleMessageStreamEvent[]): {
  readonly pending: PendingInputBatch | undefined;
  readonly resolved: ResolvedInputBatch | undefined;
} {
  let pending: PendingInputBatch | undefined;
  let requested: PendingInputBatch | undefined;
  let resolved: ResolvedInputBatch | undefined;
  for (const event of events) {
    if (event.type === "input.requested") {
      requested = pendingInputBatch(event);
      pending = requested;
    } else if (event.type === "input.resolved") {
      if (requested === undefined) continue;
      const responses = new Map<string, InputResponse | undefined>();
      for (const resolution of event.data.resolutions) {
        responses.set(resolution.requestId, resolution.response);
      }
      resolved = { batch: requested, responses };
      if (pending !== undefined) pending = withoutResolved(pending, event.data.resolutions);
    } else if (event.type === "turn.started") {
      pending = undefined;
    }
  }
  return { pending, resolved };
}

function latestPendingInputBatch(
  events: readonly HandleMessageStreamEvent[],
): PendingInputBatch | undefined {
  return foldInputBatches(events).pending;
}

/** True when `responses` exactly repeats the answers eve already accepted for the last batch. */
function replaysResolvedBatch(
  events: readonly HandleMessageStreamEvent[],
  responses: readonly InputResponse[],
): boolean {
  const resolved = foldInputBatches(events).resolved;
  if (resolved === undefined || responses.length !== resolved.responses.size) return false;
  const seen = new Set<string>();
  for (const response of responses) {
    const rawRequestId = resolved.batch.rawRequestIds[response.requestId];
    if (rawRequestId === undefined || seen.has(rawRequestId)) return false;
    seen.add(rawRequestId);
    if (!resolved.responses.has(rawRequestId)) return false;
    const accepted = resolved.responses.get(rawRequestId);
    if (accepted?.optionId !== response.optionId || accepted?.text !== response.text) {
      return false;
    }
  }
  return true;
}

function projectNonterminal(
  invocationId: string,
  createdAt: string,
  expiresAt: string | undefined,
  events: readonly HandleMessageStreamEvent[],
): AgentInvocation {
  const authorizations = new Map<string, AgentInvocationAuthorizationRequest>();
  let inputBatch: PendingInputBatch | undefined;
  let result: JsonValue | undefined;
  for (const event of events) {
    if (event.type === "input.requested") {
      inputBatch = pendingInputBatch(event);
    } else if (event.type === "input.resolved") {
      if (inputBatch !== undefined) {
        inputBatch = withoutResolved(inputBatch, event.data.resolutions);
      }
    } else if (event.type === "turn.started") {
      authorizations.clear();
      inputBatch = undefined;
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
  const base = { createdAt, expiresAt, invocationId, result };
  if (pendingAuthorizations.length > 0) {
    return {
      ...base,
      authorizations: pendingAuthorizations as [
        AgentInvocationAuthorizationRequest,
        ...AgentInvocationAuthorizationRequest[],
      ],
      pollAfterMs: 1_000,
      status: "authorization_required",
    };
  }
  if (inputBatch !== undefined) {
    return { ...base, inputRequests: inputBatch.requests, status: "input_required" };
  }
  return { ...base, pollAfterMs: 1_000, status: "working" };
}

async function terminalInvocation(
  run: {
    readonly createdAt: Date;
    readonly error?: unknown;
    readonly expiredAt?: Date;
    readonly runId: string;
    readonly status: string;
  },
  events: readonly HandleMessageStreamEvent[],
): Promise<AgentInvocation> {
  const base = {
    createdAt: run.createdAt.toISOString(),
    expiresAt: run.expiredAt?.toISOString(),
    invocationId: run.runId,
  };
  if (run.status === "cancelled") return { ...base, status: "cancelled" };
  if (run.status === "failed") {
    return {
      ...base,
      error: publicInvocationFailure(run.runId, events),
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

function publicInvocationFailure(
  runId: string,
  events: readonly HandleMessageStreamEvent[],
): Extract<AgentInvocation, { readonly status: "failed" }>["error"] {
  const event = [...events].reverse().find((candidate) => candidate.type === "session.failed");
  const data: Record<string, string> = { runId };
  if (event !== undefined) data.eveCode = event.data.code;

  const deploymentId = vercelDeploymentId();
  if (deploymentId !== undefined) data.vercelDeploymentId = deploymentId;
  if (typeof event?.data.details?.errorId === "string") data.errorId = event.data.details.errorId;

  const semantic = event === undefined ? null : semanticFailure(event.data);
  if (semantic === null) {
    const fallback = event === undefined ? null : fallbackFailure(event.data);
    if (fallback === null) return { code: -32603, data, message: "Invocation failed." };
    if (fallback.name !== undefined) data.name = fallback.name;
    return { code: -32603, data, message: fallback.message };
  }

  data.semanticErrorId = semantic.id;
  data.name = semantic.name;
  if (semantic.hint !== undefined) data.hint = semantic.hint;
  return { code: -32603, data, message: semantic.message };
}

function semanticFailure(
  event: Extract<HandleMessageStreamEvent, { type: "session.failed" }>["data"],
): {
  readonly hint?: string;
  readonly id: string;
  readonly message: string;
  readonly name: string;
} | null {
  const details = event.details;
  if (
    typeof details?.semanticErrorId !== "string" ||
    details.semanticErrorId.trim().length === 0 ||
    typeof details.name !== "string" ||
    details.name.trim().length === 0
  ) {
    return null;
  }

  const message =
    typeof details.message === "string" && details.message.trim().length > 0
      ? details.message.trim()
      : event.message.trim();
  if (message.length === 0) return null;

  const hint =
    typeof details.hint === "string" && details.hint.trim().length > 0
      ? details.hint.trim()
      : undefined;
  const summary: {
    hint?: string;
    id: string;
    message: string;
    name: string;
  } = {
    id: details.semanticErrorId,
    message,
    name: details.name,
  };
  if (hint !== undefined) summary.hint = hint;
  return summary;
}

function fallbackFailure(
  event: Extract<HandleMessageStreamEvent, { type: "session.failed" }>["data"],
): {
  readonly message: string;
  readonly name?: string;
} | null {
  const message = event.message.trim();
  const name = typeof event.details?.name === "string" ? event.details.name.trim() : "";
  if (message.length === 0 && name.length === 0) return null;
  const fallback: { message: string; name?: string } = {
    message: message.length === 0 ? name : truncateForDisplay(message),
  };
  if (name.length > 0) fallback.name = name;
  return fallback;
}

function truncateForDisplay(value: string, maxChars = 160): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function vercelDeploymentId(): string | undefined {
  if (process.env.VERCEL !== "1") return undefined;
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  return deploymentId && deploymentId.length > 0 ? deploymentId : undefined;
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
