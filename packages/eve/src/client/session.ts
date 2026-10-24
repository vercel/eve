import type { SessionStreamEvent } from "#protocol/session-event.js";
import { throwIfAborted } from "#client/abort-signal.js";
import { deliveryEvents } from "#client/delivery-events.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/session-http.js";
import {
  EVE_SESSION_ROUTE_PATH,
  createEveSessionRoutePath,
  createEveSessionStreamRoutePath,
} from "#protocol/routes.js";
import { ClientAgentSession } from "#client/agent-session.js";
import { ClientError, createClientError } from "#client/client-error.js";
import { messageForRequest } from "#client/file-parts.js";
import { StreamDelivery, type Delivery } from "#client/delivery.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { followStreamIterable, sleep, type FollowedEvent } from "#client/open-stream.js";
import { prewarmClientSession, sendClientControl } from "#client/session-controls.js";
import type { PrewarmSessionResult } from "#protocol/prewarm-session.js";
import { serializeOutputSchema } from "#tools/schema.js";
import { createClientUrl } from "#client/url.js";
import type { Answer } from "#shared/input.js";
import type {
  ClientSessionState,
  ClientRedirectPolicy,
  CreateSessionOptions,
  RespondTurnOptions,
  SendTurnInput,
  SendTurnOptions,
  SendTurnPayload,
  SessionSnapshot,
  SessionStreamOptions,
} from "#client/types.js";

const SESSION_SEND_RETRY_BASE_DELAY_MS = 250;
const SESSION_SEND_RETRY_MAX_DELAY_MS = 2_000;
const SESSION_SEND_READY_TIMEOUT_MS = 20_000;
const followSession = Symbol("followClientSession");

interface FollowSessionOptions extends SessionStreamOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly onCaughtUp?: () => void;
  readonly resolveReconnectPolicy?: () => SessionStreamOptions["streamReconnectPolicy"];
  readonly resolveHeaders?: () => Readonly<Record<string, string>> | undefined;
}

/**
 * Internal interface that a {@link ClientSession} uses to access client-level
 * configuration without depending on the full {@link Client} class.
 */
export interface ClientSessionContext {
  readonly baseUrl: string;
  readonly redirect?: ClientRedirectPolicy;
  resolveHeaders(perRequest?: Readonly<Record<string, string>>): Promise<Headers>;
}

/** One fixed, ID-addressed conversation with an eve agent. */
export class ClientSession {
  readonly #context: ClientSessionContext;
  #state: ClientSessionState;

  /** @internal */
  constructor(context: ClientSessionContext, state: ClientSessionState) {
    this.#context = context;
    this.#state = state;
  }

  /** @internal */
  static async create<TOutput = unknown>(
    context: ClientSessionContext,
    input: SendTurnInput<TOutput> & CreateSessionOptions,
  ): Promise<{ readonly delivery: Delivery<TOutput>; readonly session: ClientSession }> {
    const response = await postTurn(context, EVE_SESSION_ROUTE_PATH, input, true, input.stubs);
    const { sessionId, deliveryId } = await readAcceptedMessage(response);
    const session = new ClientSession(context, { sessionId, streamIndex: 0 });

    return {
      delivery: session.#messageResponse<TOutput>(response, input, 0, deliveryId),
      session,
    };
  }

  /** @internal */
  static async prewarm(
    context: ClientSessionContext,
    options: CreateSessionOptions = {},
  ): Promise<ClientSession> {
    const response = await postCreateSession(context, options);
    const { sessionId } = await readAcceptedMessage(response);
    return new ClientSession(context, { sessionId, streamIndex: 0 });
  }

  /** The fixed session ID; reading it performs no I/O. */
  get id(): string {
    return this.#state.sessionId;
  }

  /** Current fixed session identity and durable stream cursor. */
  get state(): ClientSessionState {
    return this.#state;
  }

  /** Reads a finite prefix through the durable tail without advancing this handle. */
  async snapshot(options?: { readonly signal?: AbortSignal }): Promise<SessionSnapshot> {
    throwIfAborted(options?.signal);
    const events: SessionStreamEvent[] = [];
    let streamIndex = 0;

    for await (const { cursor, event } of this.#readStream({
      follow: false,
      signal: options?.signal,
      startIndex: 0,
    })) {
      events.push(event);
      streamIndex = cursor;
    }

    throwIfAborted(options?.signal);
    return { events, session: { sessionId: this.#state.sessionId, streamIndex } };
  }

  /** Sends a message to this exact session ID. */
  async send<TOutput = unknown>(
    message: SendTurnInput<TOutput>["message"],
    options: SendTurnOptions<TOutput> = {},
  ): Promise<Delivery<TOutput>> {
    return await this.#send({ ...options, message }, true);
  }

  /** Answers pending input requests on this exact session ID. */
  async respond<TOutput = unknown>(
    answers: readonly Answer[],
    options: RespondTurnOptions<TOutput> = {},
  ): Promise<Delivery<TOutput>> {
    if (answers.length === 0) {
      throw new Error("ClientSession.respond() requires at least one answer.");
    }
    return await this.#send({ ...options, answers }, false);
  }

  async #send<TOutput = unknown>(
    input: SendTurnPayload<TOutput>,
    retrySessionNotReady: boolean,
  ): Promise<Delivery<TOutput>> {
    const initialStreamIndex = this.#state.streamIndex;
    const path = createEveSessionRoutePath(this.#state.sessionId);
    const response = retrySessionNotReady
      ? await postSessionSend(this.#context, path, input)
      : await postTurn(this.#context, path, input, false);
    const { sessionId: responseSessionId, deliveryId } = await readAcceptedMessage(
      response,
      this.#state.sessionId,
    );
    if (responseSessionId !== this.#state.sessionId) {
      throw new Error("Message route returned a different session id.");
    }
    if (deliveryId === undefined) {
      throw new Error(
        "Message route did not return a delivery id. Update the server before sending with this client.",
      );
    }
    return this.#messageResponse<TOutput>(response, input, initialStreamIndex, deliveryId);
  }

  /** Requests preparation of an existing idle session; never starts a model turn. */
  async prewarm(options?: { readonly signal?: AbortSignal }): Promise<PrewarmSessionResult> {
    return await prewarmClientSession({
      context: this.#context,
      sessionId: this.#state.sessionId,
      signal: options?.signal,
    });
  }

  /** Requests cooperative cancellation of this session's active turn. */
  async cancel(options?: {
    readonly signal?: AbortSignal;
    readonly turnId?: string | null;
  }): Promise<Delivery> {
    return this.#control("cancel", options);
  }

  /** Queues removal of this session's durable model-message history. */
  async clear(options?: { readonly signal?: AbortSignal }): Promise<Delivery> {
    return this.#control("clear", options);
  }

  /** Queues context compaction without sending model input. */
  async compact(options?: { readonly signal?: AbortSignal }): Promise<Delivery> {
    return this.#control("compact", options);
  }

  /** Terminally retires this exact session ID. The handle remains pinned to it. */
  async reset(options?: {
    readonly reason?: string;
    readonly signal?: AbortSignal;
  }): Promise<Delivery> {
    return this.#control("reset", options);
  }

  async #control(
    kind: "cancel" | "clear" | "compact" | "reset",
    options?: {
      readonly signal?: AbortSignal;
      readonly turnId?: string | null;
      readonly reason?: string;
    },
  ): Promise<Delivery> {
    const startIndex = this.#state.streamIndex;
    const receipt = await sendClientControl({
      context: this.#context,
      kind,
      options,
      sessionId: this.#state.sessionId,
    });
    return new StreamDelivery({
      ...receipt,
      createStream: (read) =>
        this.#createEventStream(
          startIndex,
          { signal: read?.signal },
          receipt.deliveryId,
          kind !== "reset",
        ),
    });
  }

  /** Opens this session's durable event stream from its stored cursor. */
  stream(options?: SessionStreamOptions): AsyncIterable<SessionStreamEvent> {
    return this.#streamAndAdvance(options);
  }

  /**
   * The session an agent run opened, as this session's stream linked it.
   * Pass a `child.opened` event from this session, then follow the child
   * with `stream()`; reads use this session's base URL and credentials, for local
   * and remote agents alike.
   */
  agent(opened: Extract<SessionStreamEvent, { type: "child.opened" }>): ClientAgentSession {
    return new ClientAgentSession(this.#context, this.id, opened);
  }

  [followSession](options: FollowSessionOptions): AsyncIterable<SessionStreamEvent> {
    return this.#streamAndAdvance(options);
  }

  #messageResponse<TOutput>(
    response: Response,
    input: SendTurnPayload,
    initialStreamIndex: number,
    deliveryId?: string,
  ): Delivery<TOutput> {
    response.body?.cancel().catch(() => {});
    if (deliveryId === undefined) throw new Error("Message route did not return a delivery id.");
    return new StreamDelivery<TOutput>({
      createStream: (read) =>
        this.#createEventStream(initialStreamIndex, { ...input, signal: read?.signal }, deliveryId),
      deliveryId,
      sessionId: this.#state.sessionId,
    });
  }

  #createEventStream(
    initialStreamIndex: number,
    input: SendTurnOptions,
    deliveryId: string,
    follow = true,
  ): AsyncGenerator<SessionStreamEvent> {
    return deliveryEvents(
      this.#streamAndAdvance({
        follow,
        headers: input.headers,
        signal: input.signal,
        startIndex: initialStreamIndex,
        streamReconnectPolicy: input.streamReconnectPolicy,
      }),
      deliveryId,
      input.signal,
    );
  }

  async *#streamAndAdvance(options?: FollowSessionOptions): AsyncGenerator<SessionStreamEvent> {
    const startIndex = options?.startIndex ?? this.#state.streamIndex;
    for await (const { cursor, event } of this.#readStream({
      follow: options?.follow,
      headers: options?.headers,
      onCaughtUp: options?.onCaughtUp,
      resolveHeaders: options?.resolveHeaders,
      resolveReconnectPolicy: options?.resolveReconnectPolicy,
      signal: options?.signal,
      startIndex,
      streamReconnectPolicy: options?.streamReconnectPolicy,
    })) {
      this.#advanceStreamIndex(cursor);
      yield event;
    }
  }

  #advanceStreamIndex(streamIndex: number): void {
    this.#state = {
      sessionId: this.#state.sessionId,
      streamIndex: Math.max(this.#state.streamIndex, streamIndex),
    };
  }

  #readStream(input: {
    readonly onCaughtUp?: () => void;
    readonly resolveReconnectPolicy?: () => SessionStreamOptions["streamReconnectPolicy"];
    readonly follow?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly startIndex: number;
    readonly streamReconnectPolicy?: SessionStreamOptions["streamReconnectPolicy"];
    readonly resolveHeaders?: () => Readonly<Record<string, string>> | undefined;
  }): AsyncIterable<FollowedEvent> {
    return followStreamIterable({
      onCaughtUp: input.onCaughtUp,
      follow: input.follow,
      baseUrl: this.#context.baseUrl,
      resolveHeaders: () => this.#context.resolveHeaders(input.resolveHeaders?.() ?? input.headers),
      path: createEveSessionStreamRoutePath(this.#state.sessionId),
      redirect: this.#context.redirect,
      signal: input.signal,
      startIndex: input.startIndex,
      streamReconnectPolicy: input.streamReconnectPolicy,
      resolveReconnectPolicy: input.resolveReconnectPolicy,
    });
  }
}

/** @internal Follow continuously while the frontend owns the session. */
export function followClientSession(
  session: ClientSession,
  options: FollowSessionOptions,
): AsyncIterable<SessionStreamEvent> {
  return session[followSession](options);
}

async function postSessionSend(
  context: ClientSessionContext,
  path: string,
  input: SendTurnPayload,
): Promise<Response> {
  const readyDeadline = Date.now() + SESSION_SEND_READY_TIMEOUT_MS;
  let retryDelayMs = SESSION_SEND_RETRY_BASE_DELAY_MS;
  for (;;) {
    try {
      return await postTurn(context, path, input, false);
    } catch (error) {
      if (!isSessionNotReady(error)) throw error;
      const remainingMs = readyDeadline - Date.now();
      if (remainingMs <= 0) throw error;
      await sleep(Math.min(retryDelayMs, remainingMs), input.signal);
    }

    throwIfAborted(input.signal);
    retryDelayMs = Math.min(retryDelayMs * 2, SESSION_SEND_RETRY_MAX_DELAY_MS);
  }
}

async function postCreateSession(
  context: ClientSessionContext,
  options: CreateSessionOptions,
): Promise<Response> {
  const headers = await context.resolveHeaders(options.headers);
  const body = options.stubs === undefined ? undefined : JSON.stringify({ stubs: options.stubs });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(createClientUrl(context.baseUrl, EVE_SESSION_ROUTE_PATH), {
    body,
    headers,
    method: "POST",
    redirect: context.redirect,
    signal: options.signal ?? null,
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new ClientError(response.status, responseBody, response.headers);
  }
  return response;
}

function isSessionNotReady(error: unknown): boolean {
  return SessionNotActiveError.is(error) && error.retryable;
}

async function postTurn(
  context: ClientSessionContext,
  path: string,
  input: SendTurnPayload,
  requireMessage: boolean,
  stubs?: CreateSessionOptions["stubs"],
): Promise<Response> {
  const body = createMessageBody(input, requireMessage);
  if (body === null) {
    throw new Error(
      requireMessage
        ? "Creating a session requires a non-empty message."
        : "A session turn requires a non-empty message or answers.",
    );
  }
  if (stubs !== undefined) body.stubs = stubs;

  const headers = await context.resolveHeaders(input.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(createClientUrl(context.baseUrl, path), {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    redirect: context.redirect,
    signal: input.signal ?? null,
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw createClientError(response.status, responseBody, response.headers);
  }
  return response;
}

async function readAcceptedMessage(
  response: Response,
  expected?: string,
): Promise<{
  readonly sessionId: string;
  readonly deliveryId?: string;
}> {
  const payload = (await response.json()) as Record<string, unknown>;
  const sessionId =
    (typeof payload.sessionId === "string" ? payload.sessionId : undefined) ??
    response.headers.get(EVE_SESSION_ID_HEADER)?.trim() ??
    expected;
  if (!sessionId) throw new Error("Message route did not return a session id.");
  return {
    sessionId,
    deliveryId:
      typeof payload.deliveryId === "string" && payload.deliveryId.length > 0
        ? payload.deliveryId
        : undefined,
  };
}

function createMessageBody(
  input: SendTurnPayload,
  requireMessage: boolean,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (input.message !== undefined) body.message = messageForRequest(input.message);
  if (input.answers !== undefined && input.answers.length > 0) {
    body.answers = input.answers;
  }
  if (!requireMessage && input.message !== undefined && input.turnPolicy !== undefined) {
    body.turnPolicy = input.turnPolicy;
  }
  if (input.clientContext !== undefined) body.clientContext = input.clientContext;
  const outputSchema = serializeOutputSchema(input.outputSchema);
  if (outputSchema !== undefined) body.outputSchema = outputSchema;

  if (requireMessage && body.message === undefined) return null;
  if (body.message === undefined && body.answers === undefined) return null;
  return body;
}
