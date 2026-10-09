import { failureOf } from "#client/session-utils.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { UserContent } from "ai";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import type { ChannelFrom } from "#channel/channel-operations.js";
import { streamSessionEvents } from "#execution/session-event-stream.js";
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
import {
  foldSessionEvents,
  type OpenSignIn,
  openInputs,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { type InputRequest, type InputResponse, parseInputResponses } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";

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
      input: { message: input.message },
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
    return (await this.#readCurrent(input))?.invocation;
  }

  async update(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
    readonly responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult> {
    const current = await this.#readCurrent(input);
    if (current === undefined) return { type: "not_found" };
    const { invocation, stream, token } = current;
    const pendingBatch = stream?.pending;
    if (invocation.status !== "input_required" || pendingBatch === undefined) {
      // A retry after a lost response is the common case here: the answer
      // already landed, so acknowledge it instead of demanding a new one.
      if (stream !== undefined && replaysSettledBatch(stream, input.responses)) {
        return { invocation, type: "success" };
      }
      return conflict("Invocation is not waiting for input.");
    }
    const responseIds = new Set<string>();
    const deliveredResponses: InputResponse[] = [];
    for (const response of input.responses) {
      const request = pendingBatch.get(response.requestId);
      if (request === undefined) {
        return conflict(`Unknown input request: ${response.requestId}`);
      }
      responseIds.add(response.requestId);
      deliveredResponses.push({ ...response, requestId: request.requestId });
    }
    if (responseIds.size !== input.responses.length || responseIds.size !== pendingBatch.size) {
      return conflict("Responses must answer the complete pending input batch exactly once.");
    }
    if (token === undefined) return { type: "not_found" };
    try {
      await this.#from(token).respond(parseInputResponses(deliveredResponses), {
        auth: input.auth,
      });
    } catch (error) {
      if (RunExpiredError.is(error)) return { type: "not_found" };
      throw error;
    }

    return {
      invocation: workingInvocation(input.invocationId, invocation.createdAt, invocation.expiresAt),
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

  async #readCurrent(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<
    | {
        readonly invocation: AgentInvocation;
        readonly stream?: InvocationStream;
        readonly token?: string;
      }
    | undefined
  > {
    const run = await this.#readInvocationRun(input.invocationId, input.auth);
    if (run === undefined) return undefined;
    const base = {
      createdAt: run.createdAt.toISOString(),
      expiresAt: run.expiredAt?.toISOString(),
      invocationId: run.runId,
    };
    if (run.status === "cancelled") return { invocation: { ...base, status: "cancelled" } };
    const stream = await readInvocationStream(input.invocationId);
    return {
      invocation: projectInvocation(base, run.status, stream),
      stream,
      token: run.attributes[INVOCATION_TOKEN_ATTRIBUTE],
    };
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

/** The requests one `interaction.opened` introduced, by the batch-scoped id clients answer. */
type InputBatch = ReadonlyMap<string, InputRequest>;

interface InvocationFailure {
  readonly error: ErrorInfo;
  readonly terminal: boolean;
}

/** The session's shared projection, plus what an invocation shows that it doesn't keep. */
interface InvocationStream {
  readonly projection: SessionProjection;
  /** The batches in the order they were requested, each holding the requests it introduced. */
  readonly batches: readonly InputBatch[];
  /** The latest batch with requests still open, narrowed to them. */
  readonly pending: InputBatch | undefined;
  /** Each sign-in still open, in the order they opened. */
  readonly signIns: readonly OpenSignIn[];
  /** The latest turn's final message. */
  readonly result: JsonValue | undefined;
  /** How the latest turn ended; reset when a turn starts or a park resumes. */
  readonly settled: "completed" | "cancelled" | InvocationFailure | undefined;
}

async function readInvocationStream(invocationId: string): Promise<InvocationStream> {
  const batches: InputBatch[] = [];
  let result: JsonValue | undefined;
  let settled: InvocationStream["settled"];
  const parts = new Map<string, { readonly kind: string; readonly value: JsonValue | undefined }>();
  const opened: { readonly key: string; readonly line: number; readonly ids: string[] }[] = [];
  const events = streamSessionEvents(invocationId, { follow: false });
  const { projection, signIns } = await foldSessionEvents(events, (event, before) => {
    switch (event.type) {
      case "turn.started":
        result = undefined;
        settled = undefined;
        parts.clear();
        break;
      case "interaction.opened": {
        // One commit's requests are one batch. The projection keeps the first request under an
        // id, so a batch claims only new ids.
        if (event.data.request.kind === "sign-in") break;
        if (before.inputs[event.data.interactionId] !== undefined) break;
        const { line, index } = event.meta.position;
        const current = opened.at(-1);
        if (current?.line === line) current.ids.push(event.data.interactionId);
        else opened.push({ ids: [event.data.interactionId], key: `${line}.${index}`, line });
        break;
      }
      case "interaction.settled":
        settled = undefined;
        break;
      case "content.completed":
        if (event.data.phase === "reply")
          parts.set(event.data.partId, {
            kind: event.data.kind,
            value: event.data.value,
          });
        break;
      case "turn.resumed":
      case "turn.paused":
        result = undefined;
        settled = undefined;
        break;
      case "turn.settled": {
        const reply = (event.data.reply ?? []).flatMap((partId) => {
          const part = parts.get(partId);
          return part === undefined ? [] : [part];
        });
        const structured = reply.find((part) => part.kind === "result");
        const text = reply.flatMap((part) =>
          part.kind === "text" && typeof part.value === "string" ? [part.value] : [],
        );
        result =
          structured !== undefined
            ? structured.value
            : text.length === 0
              ? undefined
              : text.join("\n");
        const error = failureOf(event);
        settled =
          error === undefined
            ? event.data.outcome === "cancelled"
              ? "cancelled"
              : "completed"
            : { error, terminal: false };
        break;
      }
      case "session.ended": {
        const error = failureOf(event);
        if (error !== undefined) settled = { error, terminal: true };
        else if (settled === undefined) settled = "completed";
        break;
      }
    }
  });
  for (const batch of opened) {
    batches.push(
      new Map(
        batch.ids.flatMap((id) => {
          const request = projection.inputs[id]?.request;
          return request === undefined
            ? []
            : [[invocationInputRequestId(batch.key, request.requestId), request] as const];
        }),
      ),
    );
  }
  const open = new Set(openInputs(projection).map((input) => input.request.requestId));
  let pending: InputBatch | undefined;
  for (const batch of batches.toReversed()) {
    const stillOpen = new Map([...batch].filter(([, request]) => open.has(request.requestId)));
    if (stillOpen.size === 0) continue;
    pending = stillOpen;
    break;
  }
  return { batches, pending, projection, result, settled, signIns };
}

/** An open sign-in as the invocation API reports it. */
function authorizationRequestOf(open: OpenSignIn): AgentInvocationAuthorizationRequest {
  const request: {
    -readonly [
      K in keyof AgentInvocationAuthorizationRequest
    ]: AgentInvocationAuthorizationRequest[K];
  } = {
    description: open.prompt,
    name: open.name,
  };
  const signIn = open.signIn;
  if (signIn === undefined) return request;
  const challenge: {
    url?: string;
    userCode?: string;
    expiresAt?: string;
    instructions?: string;
    displayName?: string;
  } = {};
  if (signIn.url !== undefined) challenge.url = signIn.url;
  if (signIn.userCode !== undefined) challenge.userCode = signIn.userCode;
  if (signIn.expiresAt !== undefined) challenge.expiresAt = signIn.expiresAt;
  if (signIn.instructions !== undefined) challenge.instructions = signIn.instructions;
  if (signIn.displayName !== undefined) challenge.displayName = signIn.displayName;
  if (signIn.callbackUrl !== undefined) {
    request.authorization = challenge;
    request.webhookUrl = signIn.callbackUrl;
  }
  return request;
}

/** True when `responses` exactly repeats the answers eve accepted for the latest batch. */
function replaysSettledBatch(
  stream: InvocationStream,
  responses: readonly InputResponse[],
): boolean {
  const batch = stream.batches.at(-1);
  if (batch === undefined || responses.length !== batch.size) return false;
  const seen = new Set<string>();
  for (const response of responses) {
    const rawRequestId = batch.get(response.requestId)?.requestId;
    if (rawRequestId === undefined || seen.has(rawRequestId)) return false;
    seen.add(rawRequestId);
    const input = stream.projection.inputs[rawRequestId];
    if (input?.status !== "settled" || input.response === undefined) return false;
    if (input.response.optionId !== response.optionId || input.response.text !== response.text) {
      return false;
    }
  }
  return true;
}

/**
 * Projects the invocation from its session. The session parks after the
 * turn settles, so `turn.settled` or a failure — not the run
 * status — is what completes the invocation. An open sign-in or input
 * request outranks how the turn ended.
 */
function projectInvocation(
  base: { readonly createdAt: string; readonly expiresAt?: string; readonly invocationId: string },
  runStatus: string,
  stream: InvocationStream,
): AgentInvocation {
  const { result, settled } = stream;
  const failure = typeof settled === "object" ? settled : undefined;
  const failed = (): AgentInvocation => ({
    ...base,
    error: publicInvocationFailure(base.invocationId, failure?.error),
    status: "failed",
  });
  // A pending batch can outlive its session (timeout, failure); nobody can answer it then.
  if (runStatus === "failed" || failure?.terminal === true) return failed();
  if (runStatus === "completed") return { ...base, result, status: "completed" };
  const authorizations = stream.signIns.map(authorizationRequestOf);
  if (authorizations.length > 0) {
    return {
      ...base,
      authorizations: authorizations as [
        AgentInvocationAuthorizationRequest,
        ...AgentInvocationAuthorizationRequest[],
      ],
      pollAfterMs: 1_000,
      result,
      status: "authorization_required",
    };
  }
  if (stream.pending !== undefined) {
    const inputRequests = Object.fromEntries(
      [...stream.pending].map(([requestId, request]) => [requestId, { ...request, requestId }]),
    );
    return { ...base, inputRequests, result, status: "input_required" };
  }
  if (failure !== undefined) return failed();
  if (settled === "cancelled") return { ...base, status: "cancelled" };
  if (settled === "completed") return { ...base, result, status: "completed" };
  return { ...base, pollAfterMs: 1_000, result, status: "working" };
}

function workingInvocation(
  invocationId: string,
  createdAt: string,
  expiresAt: string | undefined,
): AgentInvocation {
  return { createdAt, expiresAt, invocationId, pollAfterMs: 1_000, status: "working" };
}

function publicInvocationFailure(
  runId: string,
  error: ErrorInfo | undefined,
): Extract<AgentInvocation, { readonly status: "failed" }>["error"] {
  const data: Record<string, string> = { runId };
  const deploymentId = vercelDeploymentId();
  if (deploymentId !== undefined) data.vercelDeploymentId = deploymentId;
  if (error !== undefined) {
    data.eveCode = error.code;
    if (error.id !== undefined) data.errorId = error.id;
    if (error.hint !== undefined) data.hint = error.hint;
  }
  return { code: -32603, data, message: error?.message ?? "Invocation failed." };
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
