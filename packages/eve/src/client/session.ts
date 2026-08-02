import type { MessageStreamEvent } from "#protocol/message.js";
import { EVE_SESSION_ID_HEADER, isCurrentTurnBoundaryEvent } from "#protocol/message.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import { ClearResponseSchema } from "#protocol/clear-session.js";
import { CompactResponseSchema } from "#protocol/compact-session.js";
import { ResetResponseSchema } from "#protocol/reset-session.js";
import {
  EVE_CREATE_SESSION_ROUTE_PATH,
  EVE_CLEAR_SESSION_ROUTE_PATH,
  EVE_COMPACT_SESSION_ROUTE_PATH,
  EVE_RESET_SESSION_ROUTE_PATH,
  createEveCancelTurnRoutePath,
  createEveContinueSessionRoutePath,
} from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { MessageResponse } from "#client/message-response.js";
import { followStreamIterable } from "#client/open-stream.js";
import { advanceSession, createInitialSessionState } from "#client/session-utils.js";
import { serializeOutputSchema } from "#shared/tool-schema.js";
import { createClientUrl } from "#client/url.js";
import type {
  CancelSessionResult,
  ClearResult,
  CompactResult,
  ClientRedirectPolicy,
  ResetResult,
  SendTurnInput,
  SendTurnPayload,
  SessionSnapshot,
  SessionState,
  StreamOptions,
} from "#client/types.js";

const DELIVER_RETRY_ATTEMPTS = 10;
const DELIVER_RETRY_DELAY_MS = 200;

/**
 * Internal interface that a {@link ClientSession} uses to access client-level
 * configuration without depending on the full {@link Client} class.
 */
interface SessionContext {
  readonly host: string;
  readonly preserveCompletedSessions: boolean;
  readonly redirect?: ClientRedirectPolicy;
  resolveHeaders(perRequest?: Readonly<Record<string, string>>): Promise<Headers>;
}

/**
 * One conversation with an eve agent.
 *
 * A session tracks conversation state (continuation token, session ID, stream
 * cursor) automatically across {@link send} calls. Read the state from
 * the {@link state} getter and serialize it to persist a session.
 */
export class ClientSession {
  readonly #context: SessionContext;
  #state: SessionState;

  /** @internal */
  constructor(context: SessionContext, state: SessionState) {
    this.#context = context;
    this.#state = state;
  }

  /**
   * Current session cursor. The assigned session ID appears as soon as a send
   * is accepted; the continuation token and stream index advance as its event
   * stream is consumed. Serialize this to persist and resume later.
   */
  get state(): SessionState {
    return this.#state;
  }

  /**
   * Reads a finite, point-in-time prefix of this session's durable event stream.
   *
   * The read starts at the beginning of the session and stops at the durable
   * tail observed when it opens. The returned cursor points exactly after the
   * returned events, so it can hydrate a UI and resume without a gap.
   * Reading a snapshot does not advance or reset this handle's state.
   *
   * @throws {Error} If the session has no session ID (no message has been sent
   *   yet).
   */
  async snapshot(options?: { readonly signal?: AbortSignal }): Promise<SessionSnapshot> {
    options?.signal?.throwIfAborted();

    const initialState = this.#state;
    const sessionId = initialState.sessionId;
    if (!sessionId) {
      throw new Error("Session has no session ID. Send a message first.");
    }

    const events: MessageStreamEvent[] = [];

    for await (const event of this.#readStream({
      follow: false,
      sessionId,
      signal: options?.signal,
      startIndex: 0,
    })) {
      events.push(event);
    }

    options?.signal?.throwIfAborted();

    const lastEvent = events.at(-1);
    const continuationToken =
      lastEvent?.type === "session.waiting"
        ? lastEvent.data.continuationToken
        : lastEvent?.type === "session.completed" && this.#context.preserveCompletedSessions
          ? initialState.continuationToken
          : undefined;
    const session: SessionState =
      continuationToken === undefined
        ? { sessionId, streamIndex: events.length }
        : { continuationToken, sessionId, streamIndex: events.length };

    return { events, session };
  }

  /**
   * Sends one turn payload to the agent.
   *
   * Pass a string as shorthand for `{ message }`, or pass an object to submit
   * follow-up text, HITL results, client context, output schema, signal, and
   * headers in a single request.
   */
  async send<TOutput = unknown>(input: SendTurnInput<TOutput>): Promise<MessageResponse<TOutput>> {
    const payload = normalizeSendTurnInput(input);
    const state = this.#state;
    const postResult = await this.#postTurn(payload, state);
    const { continuationToken, sessionId } = postResult;

    // Cancellation and observation can begin as soon as the POST is accepted,
    // before the response stream reaches a turn boundary.
    if (this.#state === state) {
      const nextState = { ...state, sessionId };
      if (continuationToken !== undefined) nextState.continuationToken = continuationToken;
      this.#state = nextState;
    }

    return new MessageResponse<TOutput>({
      continuationToken,
      createStream: () => this.#createEventStream(sessionId, continuationToken, state, payload),
      sessionId,
    });
  }

  /**
   * Requests cooperative cancellation of this session's active turn.
   *
   * Both `accepted` and `no_active_turn` are successful outcomes. The latter
   * means the active turn settled before the request arrived or the session is
   * already parked. `turnId` limits the request to the turn the caller
   * observed; a stale guard is consumed as a benign no-op. Credentials are
   * resolved immediately before the request.
   *
   * @throws {Error} If this handle has not started or attached to a session.
   * @throws {ClientError} If the cancel route returns a non-successful status.
   */
  async cancel(options?: { turnId?: string }): Promise<CancelSessionResult> {
    const sessionId = this.#state.sessionId;
    if (!sessionId) {
      throw new Error("Session has no session ID. Send a message first.");
    }

    const url = createClientUrl(this.#context.host, createEveCancelTurnRoutePath(sessionId));
    const headers = await this.#context.resolveHeaders();
    headers.set("content-type", "application/json");

    const response = await fetch(
      url,
      withRedirectPolicy(
        {
          headers,
          method: "POST",
          body: options ? JSON.stringify(options) : undefined,
        },
        this.#context.redirect,
      ),
    );
    const body = await response.text();

    if (!response.ok) {
      throw new ClientError(response.status, body, response.headers);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Cancel route returned invalid JSON (${response.status}).`);
    }

    const result = CancelTurnResponseSchema.safeParse(payload);
    if (!result.success || result.data.sessionId !== sessionId) {
      throw new Error(`Cancel route returned an invalid response (${response.status}).`);
    }

    return { sessionId: result.data.sessionId, status: result.data.status };
  }

  /**
   * Queues removal of this session's durable model-message history. The
   * session identity, agent configuration, state, limits, and sandbox remain.
   * Consume the durable stream through `context.cleared` and its following
   * `session.waiting` boundary before sending another turn.
   */
  async clear(): Promise<ClearResult> {
    const state = this.#state;
    const continuationToken = state.continuationToken;

    if (continuationToken === undefined) {
      if (state.sessionId !== undefined) {
        throw new Error(
          "Session has no continuation token. Consume its event stream before clearing.",
        );
      }
      return { status: "no_active_session" };
    }

    const url = createClientUrl(this.#context.host, EVE_CLEAR_SESSION_ROUTE_PATH);
    const headers = await this.#context.resolveHeaders();
    headers.set("content-type", "application/json");

    const response = await fetch(
      url,
      withRedirectPolicy(
        {
          body: JSON.stringify({ continuationToken }),
          headers,
          method: "POST",
        },
        this.#context.redirect,
      ),
    );
    const body = await response.text();

    if (!response.ok) {
      throw new ClientError(response.status, body, response.headers);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Clear route returned invalid JSON (${response.status}).`);
    }

    const result = ClearResponseSchema.safeParse(payload);
    if (
      !result.success ||
      (result.data.status === "accepted" &&
        state.sessionId !== undefined &&
        result.data.sessionId !== state.sessionId)
    ) {
      throw new Error(`Clear route returned an invalid response (${response.status}).`);
    }

    return result.data.status === "accepted"
      ? { sessionId: result.data.sessionId, status: "accepted" }
      : { status: "no_active_session" };
  }

  /**
   * Queues context compaction without sending model input. The request is
   * asynchronous; consume the durable event stream through its next session
   * boundary before sending another turn. `compaction.completed` confirms that
   * summarization succeeded. A never-started handle is a successful no-op.
   */
  async compact(): Promise<CompactResult> {
    const state = this.#state;
    const continuationToken = state.continuationToken;

    if (continuationToken === undefined) {
      if (state.sessionId !== undefined) {
        throw new Error(
          "Session has no continuation token. Consume its event stream before compacting.",
        );
      }
      return { status: "no_active_session" };
    }

    const url = createClientUrl(this.#context.host, EVE_COMPACT_SESSION_ROUTE_PATH);
    const headers = await this.#context.resolveHeaders();
    headers.set("content-type", "application/json");

    const response = await fetch(
      url,
      withRedirectPolicy(
        {
          body: JSON.stringify({ continuationToken }),
          headers,
          method: "POST",
        },
        this.#context.redirect,
      ),
    );
    const body = await response.text();

    if (!response.ok) {
      throw new ClientError(response.status, body, response.headers);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Compact route returned invalid JSON (${response.status}).`);
    }

    const result = CompactResponseSchema.safeParse(payload);
    if (
      !result.success ||
      (result.data.status === "accepted" &&
        state.sessionId !== undefined &&
        result.data.sessionId !== state.sessionId)
    ) {
      throw new Error(`Compact route returned an invalid response (${response.status}).`);
    }

    return result.data.status === "accepted"
      ? { sessionId: result.data.sessionId, status: "accepted" }
      : { status: "no_active_session" };
  }

  /**
   * Terminally retires the session that owns this handle's continuation token.
   *
   * Unlike {@link cancel}, reset does not merely stop an active turn: it
   * releases the durable workflow owner so the next {@link send} creates a
   * fresh conversation and initializes a new session-scoped sandbox on first
   * sandbox use. Resetting a never-started handle is a successful no-op. After
   * a successful reset, this handle has no session state.
   *
   * @throws {ClientError} If the reset route returns a non-successful status.
   */
  async reset(): Promise<ResetResult> {
    const state = this.#state;
    const continuationToken = state.continuationToken;

    if (continuationToken === undefined) {
      if (state.sessionId !== undefined) {
        throw new Error(
          "Session has no continuation token. Consume its event stream before resetting.",
        );
      }
      this.#state = createInitialSessionState();
      return { status: "no_active_session" };
    }

    const url = createClientUrl(this.#context.host, EVE_RESET_SESSION_ROUTE_PATH);
    const headers = await this.#context.resolveHeaders();
    headers.set("content-type", "application/json");

    const response = await fetch(
      url,
      withRedirectPolicy(
        {
          body: JSON.stringify({ continuationToken }),
          headers,
          method: "POST",
        },
        this.#context.redirect,
      ),
    );
    const body = await response.text();

    if (!response.ok) {
      throw new ClientError(response.status, body, response.headers);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Reset route returned invalid JSON (${response.status}).`);
    }

    const result = ResetResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new Error(`Reset route returned an invalid response (${response.status}).`);
    }
    if (
      result.data.status === "reset" &&
      state.sessionId !== undefined &&
      result.data.previousSessionId !== state.sessionId
    ) {
      throw new Error(`Reset route returned an invalid response (${response.status}).`);
    }

    if (this.#state === state) {
      this.#state = createInitialSessionState();
    }

    return result.data.status === "reset"
      ? { previousSessionId: result.data.previousSessionId, status: "reset" }
      : { status: "no_active_session" };
  }

  /**
   * Opens this session's event stream for the current session ID.
   *
   * Resumes from the session's stored stream cursor unless `options.startIndex`
   * overrides it. By default, the stream reconnects from its cursor when the
   * connection ends; pass `streamReconnectPolicy: { reconnect: false }` to use
   * one connection. Negative indices read relative to the current tail on one connection
   * and do not advance the stored absolute cursor.
   *
   * Pass `follow: false` for a bounded read: yields events up to the durable
   * tail observed when the stream opens, then returns instead of following.
   * The stored cursor still advances past the consumed events.
   *
   * @throws {Error} If the session has no session ID (no message has been sent
   *   yet), or if `follow: false` is combined with a negative `startIndex`.
   */
  stream(options?: StreamOptions): AsyncIterable<MessageStreamEvent> {
    const sessionId = this.#state.sessionId;

    if (!sessionId) {
      throw new Error("Session has no session ID. Send a message first.");
    }

    if (options?.follow === false && (options.startIndex ?? this.#state.streamIndex) < 0) {
      throw new Error(
        "stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
      );
    }

    return this.#streamAndAdvance(sessionId, options);
  }

  // ---------------------------------------------------------------------------
  // Internal: POST to message route
  // ---------------------------------------------------------------------------

  async #postTurn(
    input: SendTurnPayload,
    session: SessionState,
  ): Promise<{ continuationToken?: string; sessionId: string }> {
    const routePath = session.sessionId
      ? createEveContinueSessionRoutePath(session.sessionId)
      : EVE_CREATE_SESSION_ROUTE_PATH;
    const url = createClientUrl(this.#context.host, routePath);
    const headers = await this.#context.resolveHeaders(input.headers);
    headers.set("content-type", "application/json");

    const body = createHandleMessageBody({
      input,
      outputSchema: serializeOutputSchema(input.outputSchema),
      session,
    });

    if (body === null) {
      throw new Error("Session.send requires a non-empty message, inputResponses, or both.");
    }

    const response = await postTurnWithRetry({
      body: JSON.stringify(body),
      headers,
      mustDeliver: (input.inputResponses?.length ?? 0) > 0,
      redirect: this.#context.redirect,
      signal: input.signal,
      url,
    });

    const payload = (await response.json()) as Record<string, unknown>;

    const sessionId =
      (typeof payload.sessionId === "string" ? payload.sessionId : undefined) ??
      response.headers.get(EVE_SESSION_ID_HEADER)?.trim() ??
      session.sessionId;

    if (!sessionId) {
      throw new Error("Message route did not return a session id.");
    }

    const continuationToken =
      typeof payload.continuationToken === "string" ? payload.continuationToken : undefined;

    return { continuationToken, sessionId };
  }

  // ---------------------------------------------------------------------------
  // Internal: event stream consumption
  // ---------------------------------------------------------------------------

  async *#createEventStream(
    sessionId: string,
    continuationToken: string | undefined,
    initialState: SessionState,
    input: SendTurnPayload,
  ): AsyncGenerator<MessageStreamEvent> {
    const events: MessageStreamEvent[] = [];

    try {
      for await (const event of this.#readStream({
        headers: input.headers,
        streamReconnectPolicy: input.streamReconnectPolicy,
        sessionId,
        signal: input.signal,
        startIndex: initialState.sessionId === sessionId ? initialState.streamIndex : 0,
      })) {
        events.push(event);
        yield event;

        if (isCurrentTurnBoundaryEvent(event)) {
          break;
        }
      }
    } finally {
      this.#state = advanceSession({
        continuationToken,
        events,
        preserveCompletedSessions: this.#context.preserveCompletedSessions,
        sessionId,
        session: initialState,
      });
    }
  }

  async *#streamAndAdvance(
    sessionId: string,
    options?: StreamOptions,
  ): AsyncGenerator<MessageStreamEvent> {
    const initialState = this.#state;
    const streamIndex = options?.startIndex ?? initialState.streamIndex;
    const events: MessageStreamEvent[] = [];

    try {
      for await (const event of this.#readStream({
        follow: options?.follow,
        sessionId,
        signal: options?.signal,
        startIndex: streamIndex,
        streamReconnectPolicy: options?.streamReconnectPolicy,
      })) {
        events.push(event);
        yield event;
      }
    } finally {
      if (streamIndex >= 0) {
        this.#state = advanceSession({
          continuationToken: initialState.continuationToken,
          events,
          preserveCompletedSessions: this.#context.preserveCompletedSessions,
          session: { ...initialState, sessionId, streamIndex },
          sessionId,
        });
      }
    }
  }

  #readStream(input: {
    readonly follow?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
    readonly startIndex: number;
    readonly streamReconnectPolicy?: StreamOptions["streamReconnectPolicy"];
  }): AsyncIterable<MessageStreamEvent> {
    return followStreamIterable({
      follow: input.follow,
      host: this.#context.host,
      resolveHeaders: () => this.#context.resolveHeaders(input.headers),
      redirect: this.#context.redirect,
      streamReconnectPolicy: input.streamReconnectPolicy,
      sessionId: input.sessionId,
      signal: input.signal,
      startIndex: input.startIndex,
    });
  }
}

async function postTurnWithRetry(input: {
  readonly body: string;
  readonly headers: Headers;
  readonly mustDeliver: boolean;
  readonly redirect?: ClientRedirectPolicy;
  readonly signal?: AbortSignal;
  readonly url: string;
}): Promise<Response> {
  const attempts = input.mustDeliver ? DELIVER_RETRY_ATTEMPTS : 1;
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(input.url, {
      body: input.body,
      headers: input.headers,
      method: "POST",
      redirect: input.redirect,
      signal: input.signal ?? null,
    });

    if (response.ok) return response;

    lastStatus = response.status;
    lastBody = await response.text();
    lastHeaders = response.headers;

    if (!isRetryableDeliveryFailure(response.status, lastBody)) {
      throw new ClientError(response.status, lastBody, response.headers);
    }

    if (attempt < attempts - 1) {
      await sleep(DELIVER_RETRY_DELAY_MS);
    }
  }

  throw new ClientError(
    lastStatus ?? 0,
    lastBody ?? "Failed to deliver session turn.",
    lastHeaders,
  );
}

function isRetryableDeliveryFailure(status: number, body: string): boolean {
  return status === 500 && /target session was not found/i.test(body);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSendTurnInput<TOutput>(input: SendTurnInput<TOutput>): SendTurnPayload<TOutput> {
  return typeof input === "string" ? { message: input } : input;
}

function createHandleMessageBody(input: {
  readonly input: SendTurnPayload;
  readonly outputSchema?: Record<string, unknown>;
  readonly session: SessionState;
}): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};

  if (input.input.message !== undefined) {
    body.message = input.input.message;
  }

  if (input.input.inputResponses !== undefined && input.input.inputResponses.length > 0) {
    body.inputResponses = input.input.inputResponses;
  }

  if (input.input.clientContext !== undefined) {
    body.clientContext = input.input.clientContext;
  }

  if (input.outputSchema !== undefined) {
    body.outputSchema = input.outputSchema;
  }

  if (input.session.continuationToken !== undefined) {
    body.continuationToken = input.session.continuationToken;
  }

  if (Object.keys(body).length === 0) {
    return null;
  }

  if (input.session.continuationToken === undefined && body.message === undefined) {
    return null;
  }

  if (
    input.session.continuationToken !== undefined &&
    body.message === undefined &&
    body.inputResponses === undefined
  ) {
    return null;
  }

  return body;
}

function withRedirectPolicy(init: RequestInit, redirect?: ClientRedirectPolicy): RequestInit {
  return redirect === undefined ? init : { ...init, redirect };
}
