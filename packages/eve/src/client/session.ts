import { updatePendingAuthorizations } from "#client/session-utils.js";
import type { MessageStreamEvent, SubagentCalledStreamEvent } from "#protocol/message.js";
import { EVE_SESSION_ID_HEADER, isCurrentTurnBoundaryEvent } from "#protocol/message.js";
import {
  EVE_SESSION_ROUTE_PATH,
  createEveSessionRoutePath,
  createEveSessionStreamRoutePath,
} from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { MessageResponse } from "#client/message-response.js";
import { followStreamIterable, sleep } from "#client/open-stream.js";
import {
  cancelClientSession,
  clearClientSession,
  compactClientSession,
  resetClientSession,
} from "#client/session-controls.js";
import { serializeOutputSchema } from "#tools/schema.js";
import { createClientUrl } from "#client/url.js";
import type { InputResponse } from "#shared/input.js";
import type {
  CancelSessionResult,
  ClearResult,
  ClientSessionState,
  CompactResult,
  ClientRedirectPolicy,
  CreateSessionOptions,
  RespondTurnOptions,
  ResetResult,
  SendTurnInput,
  SendTurnOptions,
  SendTurnPayload,
  SessionSnapshot,
  StreamOptions,
} from "#client/types.js";

const SESSION_SEND_RETRY_BASE_DELAY_MS = 250;
const SESSION_SEND_RETRY_MAX_DELAY_MS = 2_000;
const SESSION_SEND_READY_TIMEOUT_MS = 20_000;
const followSession = Symbol("followClientSession");

interface FollowSessionOptions extends StreamOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly onCaughtUp?: () => void;
  readonly resolveReconnectPolicy?: () => StreamOptions["streamReconnectPolicy"];
  readonly resolveHeaders?: () => Readonly<Record<string, string>> | undefined;
}

/**
 * Internal interface that a {@link ClientSession} uses to access client-level
 * configuration without depending on the full {@link Client} class.
 */
export interface ClientSessionContext {
  readonly host: string;
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
    input: SendTurnInput<TOutput>,
  ): Promise<{ readonly response: MessageResponse<TOutput>; readonly session: ClientSession }> {
    const response = await postTurn(context, EVE_SESSION_ROUTE_PATH, input, true);
    const { sessionId } = await readAcceptedMessage(response);
    const session = new ClientSession(context, { sessionId, streamIndex: 0 });

    return {
      response: session.#messageResponse<TOutput>(response, input, 0),
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

  /** Current fixed session identity and durable stream cursor. */
  get state(): ClientSessionState {
    return this.#state;
  }

  /** Reads a finite prefix through the durable tail without advancing this handle. */
  async snapshot(options?: { readonly signal?: AbortSignal }): Promise<SessionSnapshot> {
    options?.signal?.throwIfAborted();
    const events: MessageStreamEvent[] = [];

    for await (const event of this.#readStream({
      follow: false,
      signal: options?.signal,
      startIndex: 0,
    })) {
      events.push(event);
    }

    options?.signal?.throwIfAborted();
    return {
      events,
      session: { sessionId: this.#state.sessionId, streamIndex: events.length },
    };
  }

  /** Sends a message to this exact session ID. */
  async send<TOutput = unknown>(
    message: SendTurnInput<TOutput>["message"],
    options: SendTurnOptions<TOutput> = {},
  ): Promise<MessageResponse<TOutput>> {
    return await this.#send({ ...options, message }, true);
  }

  /** Answers pending input requests on this exact session ID. */
  async respond<TOutput = unknown>(
    inputResponses: readonly InputResponse[],
    options: RespondTurnOptions<TOutput> = {},
  ): Promise<MessageResponse<TOutput>> {
    if (inputResponses.length === 0) {
      throw new Error("ClientSession.respond() requires at least one input response.");
    }
    return await this.#send({ ...options, inputResponses }, false);
  }

  async #send<TOutput = unknown>(
    input: SendTurnPayload<TOutput>,
    retrySessionNotReady: boolean,
  ): Promise<MessageResponse<TOutput>> {
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
    if (input.message !== undefined && deliveryId === undefined) {
      throw new Error(
        "Message route did not return a delivery id. Update the server before sending with this client.",
      );
    }
    return this.#messageResponse<TOutput>(
      response,
      input,
      initialStreamIndex,
      input.message === undefined ? undefined : deliveryId,
    );
  }

  /** Requests cooperative cancellation of this session's active turn. */
  async cancel(options?: {
    readonly signal?: AbortSignal;
    readonly turnId?: string;
  }): Promise<CancelSessionResult> {
    return await cancelClientSession({
      context: this.#context,
      options,
      sessionId: this.#state.sessionId,
    });
  }

  /** Queues removal of this session's durable model-message history. */
  async clear(): Promise<ClearResult> {
    return await clearClientSession({ context: this.#context, sessionId: this.#state.sessionId });
  }

  /** Queues context compaction without sending model input. */
  async compact(): Promise<CompactResult> {
    return await compactClientSession({ context: this.#context, sessionId: this.#state.sessionId });
  }

  /** Terminally retires this exact session ID. The handle remains pinned to it. */
  async reset(options?: {
    readonly reason?: string;
    readonly signal?: AbortSignal;
  }): Promise<ResetResult> {
    return await resetClientSession({
      context: this.#context,
      options,
      sessionId: this.#state.sessionId,
    });
  }

  /** Opens this session's durable event stream from its stored cursor. */
  stream(options?: StreamOptions): AsyncIterable<MessageStreamEvent> {
    if (options?.follow === false && (options.startIndex ?? this.#state.streamIndex) < 0) {
      throw new Error(
        "stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
      );
    }
    return this.#streamAndAdvance(options);
  }

  /**
   * Follows one delegated child's durable event stream through this parent session.
   *
   * Pass a `subagent.called` event from this session. The client reads its
   * `childStreamPath` with this session's host and credentials: a local child's
   * own stream route, or the parent-origin proxy for a remote child, which the
   * parent deployment authenticates to the remote agent. Reading the child never
   * advances this session's cursor. The child cursor starts at `0`; pass
   * `startIndex` to resume. Stop at a child turn boundary with
   * `isCurrentTurnBoundaryEvent`.
   *
   * @throws {Error} When `called` belongs to a different session or has no
   * `childStreamPath` because an older eve version recorded it.
   */
  streamSubagent(
    called: SubagentCalledStreamEvent,
    options?: StreamOptions,
  ): AsyncIterable<MessageStreamEvent> {
    if (called.data.sessionId !== this.#state.sessionId) {
      throw new Error(
        `streamSubagent() requires a subagent.called event from session ${this.#state.sessionId}, but it came from session ${called.data.sessionId}.`,
      );
    }
    // Events persisted before childStreamPath existed replay without it.
    if (typeof called.data.childStreamPath !== "string") {
      throw new Error(
        `streamSubagent() requires a subagent.called event with childStreamPath, but call ${called.data.callId} has none. The event was recorded by an older eve version.`,
      );
    }
    const startIndex = options?.startIndex ?? 0;
    if (options?.follow === false && startIndex < 0) {
      throw new Error(
        "streamSubagent({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
      );
    }
    return followStreamIterable({
      follow: options?.follow,
      host: this.#context.host,
      path: called.data.childStreamPath,
      redirect: this.#context.redirect,
      resolveHeaders: () => this.#context.resolveHeaders(),
      signal: options?.signal,
      startIndex,
      streamReconnectPolicy: options?.streamReconnectPolicy,
    });
  }

  [followSession](options: FollowSessionOptions): AsyncIterable<MessageStreamEvent> {
    return this.#streamAndAdvance({ ...options, keepAlive: true });
  }

  #messageResponse<TOutput>(
    response: Response,
    input: SendTurnPayload,
    initialStreamIndex: number,
    deliveryId?: string,
  ): MessageResponse<TOutput> {
    response.body?.cancel().catch(() => {});
    return new MessageResponse<TOutput>({
      cancelTurn: async (turnId) => await this.cancel({ turnId }),
      createStream: (source) =>
        this.#createEventStream(initialStreamIndex, input, deliveryId, source),
      deliveryId,
      sessionId: this.#state.sessionId,
    });
  }

  async *#createEventStream(
    initialStreamIndex: number,
    input: SendTurnPayload,
    deliveryId?: string,
    source?: AsyncIterable<MessageStreamEvent>,
  ): AsyncGenerator<MessageStreamEvent> {
    let eventCount = 0;
    let started = deliveryId === undefined;
    let reachedBoundary = false;
    const pendingAuthorizations = new Set<string>();
    try {
      for await (const event of source ??
        this.#readStream({
          headers: input.headers,
          keepAlive: true,
          signal: input.signal,
          startIndex: initialStreamIndex,
          streamReconnectPolicy: input.streamReconnectPolicy,
        })) {
        eventCount += 1;
        if (deliveryId !== undefined) {
          const matches = event.meta?.deliveryIds?.includes(deliveryId) === true;
          const terminal = event.type === "session.failed" || event.type === "session.completed";
          if (!matches && terminal && (!started || event.type === "session.completed")) {
            throw new Error(
              "The session ended before the accepted message reached its turn boundary.",
            );
          }
          if (!started && !matches) continue;
          if (!terminal && event.meta?.deliveryIds !== undefined && !matches) continue;
          started = true;
        }
        updatePendingAuthorizations(pendingAuthorizations, event);
        reachedBoundary =
          isCurrentTurnBoundaryEvent(event) &&
          (event.type !== "session.waiting" || pendingAuthorizations.size === 0);
        yield event;
        if (reachedBoundary) {
          break;
        }
      }
      if (deliveryId !== undefined && !reachedBoundary && !input.signal?.aborted) {
        throw new Error(
          "The response stream ended before the accepted message reached its turn boundary.",
        );
      }
    } finally {
      this.#advanceStreamIndex(initialStreamIndex + eventCount);
    }
  }

  async *#streamAndAdvance(
    options?: FollowSessionOptions & { readonly keepAlive?: boolean },
  ): AsyncGenerator<MessageStreamEvent> {
    const startIndex = options?.startIndex ?? this.#state.streamIndex;
    let eventCount = 0;
    for await (const event of this.#readStream({
      follow: options?.follow,
      headers: options?.headers,
      keepAlive: options?.keepAlive,
      onCaughtUp: options?.onCaughtUp,
      resolveHeaders: options?.resolveHeaders,
      resolveReconnectPolicy: options?.resolveReconnectPolicy,
      signal: options?.signal,
      startIndex,
      streamReconnectPolicy: options?.streamReconnectPolicy,
    })) {
      eventCount += 1;
      if (startIndex >= 0) this.#advanceStreamIndex(startIndex + eventCount);
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
    readonly resolveReconnectPolicy?: () => StreamOptions["streamReconnectPolicy"];
    readonly follow?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
    readonly keepAlive?: boolean;
    readonly signal?: AbortSignal;
    readonly startIndex: number;
    readonly streamReconnectPolicy?: StreamOptions["streamReconnectPolicy"];
    readonly resolveHeaders?: () => Readonly<Record<string, string>> | undefined;
  }): AsyncIterable<MessageStreamEvent> {
    return followStreamIterable({
      onCaughtUp: input.onCaughtUp,
      follow: input.follow,
      host: this.#context.host,
      keepAlive: input.keepAlive,
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
): AsyncIterable<MessageStreamEvent> {
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

    input.signal?.throwIfAborted();
    retryDelayMs = Math.min(retryDelayMs * 2, SESSION_SEND_RETRY_MAX_DELAY_MS);
  }
}

async function postCreateSession(
  context: ClientSessionContext,
  options: CreateSessionOptions,
): Promise<Response> {
  const headers = await context.resolveHeaders(options.headers);
  const response = await fetch(createClientUrl(context.host, EVE_SESSION_ROUTE_PATH), {
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

function isSessionNotReady(error: unknown): error is ClientError {
  return error instanceof ClientError && error.status === 409 && error.code === "session_not_ready";
}

async function postTurn(
  context: ClientSessionContext,
  path: string,
  input: SendTurnPayload,
  requireMessage: boolean,
): Promise<Response> {
  const body = createMessageBody(input, requireMessage);
  if (body === null) {
    throw new Error(
      requireMessage
        ? "Creating a session requires a non-empty message."
        : "A session turn requires a non-empty message or inputResponses.",
    );
  }

  const headers = await context.resolveHeaders(input.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(createClientUrl(context.host, path), {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    redirect: context.redirect,
    signal: input.signal ?? null,
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new ClientError(response.status, responseBody, response.headers);
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
  if (input.message !== undefined) body.message = input.message;
  if (input.inputResponses !== undefined && input.inputResponses.length > 0) {
    body.inputResponses = input.inputResponses;
  }
  if (!requireMessage && input.message !== undefined && input.turnPolicy !== undefined) {
    body.turnPolicy = input.turnPolicy;
  }
  if (input.clientContext !== undefined) body.clientContext = input.clientContext;
  const outputSchema = serializeOutputSchema(input.outputSchema);
  if (outputSchema !== undefined) body.outputSchema = outputSchema;

  if (requireMessage && body.message === undefined) return null;
  if (body.message === undefined && body.inputResponses === undefined) return null;
  return body;
}
