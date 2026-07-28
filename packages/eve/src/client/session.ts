import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { EVE_SESSION_ID_HEADER, isCurrentTurnBoundaryEvent } from "#protocol/message.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import {
  EVE_CREATE_SESSION_ROUTE_PATH,
  createEveCancelTurnRoutePath,
  createEveContinueSessionRoutePath,
} from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { MessageResponse } from "#client/message-response.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
import { openStreamBody, openStreamIterable } from "#client/open-stream.js";
import { normalizeOutputSchemaForRequest } from "#client/output-schema.js";
import { advanceSession } from "#client/session-utils.js";
import { createClientUrl } from "#client/url.js";
import type {
  CancelSessionResult,
  ClientRedirectPolicy,
  SendTurnInput,
  SendTurnPayload,
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
  readonly maxReconnectAttempts: number;
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
      this.#state = { ...state, sessionId };
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
   * already parked. Credentials are resolved immediately before the request.
   *
   * @throws {Error} If this handle has not started or attached to a session.
   * @throws {ClientError} If the cancel route returns a non-successful status.
   */
  async cancel(): Promise<CancelSessionResult> {
    const sessionId = this.#state.sessionId;
    if (!sessionId) {
      throw new Error("Session has no session ID. Send a message first.");
    }

    const url = createClientUrl(this.#context.host, createEveCancelTurnRoutePath(sessionId));
    const headers = await this.#context.resolveHeaders();
    const response = await fetch(
      url,
      withRedirectPolicy({ headers, method: "POST" }, this.#context.redirect),
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
   * Opens this session's event stream for the current session ID.
   *
   * Resumes from the session's stored stream cursor unless `options.startIndex`
   * overrides it. Negative indices read relative to the current tail and do
   * not reconnect or advance the stored absolute cursor. Other streams
   * reconnect on transient socket disconnects, up to the client's
   * `maxReconnectAttempts`.
   *
   * @throws {Error} If the session has no session ID (no message has been sent
   *   yet).
   */
  stream(options?: StreamOptions): AsyncIterable<HandleMessageStreamEvent> {
    const sessionId = this.#state.sessionId;

    if (!sessionId) {
      throw new Error("Session has no session ID. Send a message first.");
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
      outputSchema: normalizeOutputSchemaForRequest(input.outputSchema),
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
  // Internal: event stream with reconnection
  // ---------------------------------------------------------------------------

  async *#createEventStream(
    sessionId: string,
    continuationToken: string | undefined,
    initialState: SessionState,
    input: SendTurnPayload,
  ): AsyncGenerator<HandleMessageStreamEvent> {
    const events: HandleMessageStreamEvent[] = [];

    try {
      let currentStreamIndex = initialState.sessionId === sessionId ? initialState.streamIndex : 0;
      let remainingReconnectAttempts = this.#context.maxReconnectAttempts;

      while (true) {
        const body = await this.#openStreamBody(
          sessionId,
          currentStreamIndex,
          input.signal,
          input.headers,
        );

        let foundBoundary = false;

        try {
          for await (const event of readNdjsonStream(body)) {
            events.push(event);
            currentStreamIndex += 1;
            yield event;

            if (isCurrentTurnBoundaryEvent(event)) {
              foundBoundary = true;
              break;
            }
          }
        } catch (error) {
          if (!isStreamDisconnectError(error)) {
            throw error;
          }
        }

        if (foundBoundary) {
          break;
        }

        // A caller-initiated abort is a stop signal, not a transient socket
        // disconnect — do not reconnect.
        if (input.signal?.aborted) {
          break;
        }

        if (remainingReconnectAttempts <= 0) {
          break;
        }

        remainingReconnectAttempts -= 1;
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

  async #openStreamBody(
    sessionId: string,
    startIndex: number,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<ReadableStream<Uint8Array>> {
    return await openStreamBody({
      host: this.#context.host,
      resolveHeaders: () => this.#context.resolveHeaders(headers),
      redirect: this.#context.redirect,
      sessionId,
      signal,
      startIndex,
    });
  }

  async *#streamAndAdvance(
    sessionId: string,
    options?: StreamOptions,
  ): AsyncGenerator<HandleMessageStreamEvent> {
    const initialState = this.#state;
    const streamIndex = options?.startIndex ?? initialState.streamIndex;
    const events: HandleMessageStreamEvent[] = [];

    try {
      for await (const event of openStreamIterable({
        host: this.#context.host,
        maxReconnectAttempts: this.#context.maxReconnectAttempts,
        resolveHeaders: () => this.#context.resolveHeaders(),
        redirect: this.#context.redirect,
        sessionId,
        signal: options?.signal,
        startIndex: streamIndex,
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
