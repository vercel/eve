import type { MessageStreamEvent } from "#protocol/message.js";
import { EVE_SESSION_ID_HEADER, isCurrentTurnBoundaryEvent } from "#protocol/message.js";
import { EVE_SESSION_ROUTE_PATH, createEveSessionRoutePath } from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { MessageResponse } from "#client/message-response.js";
import { followStreamIterable } from "#client/open-stream.js";
import {
  cancelClientSession,
  clearClientSession,
  compactClientSession,
  resetClientSession,
} from "#client/session-controls.js";
import { serializeOutputSchema } from "#shared/tool-schema.js";
import { createClientUrl } from "#client/url.js";
import type {
  CancelSessionResult,
  ClearResult,
  ClientSessionState,
  CompactResult,
  ClientRedirectPolicy,
  ResetResult,
  SendTurnInput,
  SendTurnPayload,
  SessionSnapshot,
  StreamOptions,
} from "#client/types.js";

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
    const sessionId = await readSessionId(response);
    const session = new ClientSession(context, { sessionId, streamIndex: 0 });

    return {
      response: session.#messageResponse<TOutput>(response, input, 0),
      session,
    };
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

  /** Sends a turn to this exact session ID. */
  async send<TOutput = unknown>(input: SendTurnInput<TOutput>): Promise<MessageResponse<TOutput>> {
    const initialStreamIndex = this.#state.streamIndex;
    const response = await postTurn(
      this.#context,
      createEveSessionRoutePath(this.#state.sessionId),
      input,
      false,
    );
    const responseSessionId = await readSessionId(response, this.#state.sessionId);
    if (responseSessionId !== this.#state.sessionId) {
      throw new Error("Message route returned a different session id.");
    }
    return this.#messageResponse<TOutput>(response, input, initialStreamIndex);
  }

  /** Requests cooperative cancellation of this session's active turn. */
  async cancel(options?: { readonly turnId?: string }): Promise<CancelSessionResult> {
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
  async reset(options?: { readonly reason?: string }): Promise<ResetResult> {
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

  #messageResponse<TOutput>(
    response: Response,
    input: SendTurnPayload,
    initialStreamIndex: number,
  ): MessageResponse<TOutput> {
    response.body?.cancel().catch(() => {});
    return new MessageResponse<TOutput>({
      createStream: () => this.#createEventStream(initialStreamIndex, input),
      sessionId: this.#state.sessionId,
    });
  }

  async *#createEventStream(
    initialStreamIndex: number,
    input: SendTurnPayload,
  ): AsyncGenerator<MessageStreamEvent> {
    let eventCount = 0;
    try {
      for await (const event of this.#readStream({
        headers: input.headers,
        signal: input.signal,
        startIndex: initialStreamIndex,
        streamReconnectPolicy: input.streamReconnectPolicy,
      })) {
        eventCount += 1;
        yield event;
        if (isCurrentTurnBoundaryEvent(event)) break;
      }
    } finally {
      this.#state = {
        sessionId: this.#state.sessionId,
        streamIndex: initialStreamIndex + eventCount,
      };
    }
  }

  async *#streamAndAdvance(options?: StreamOptions): AsyncGenerator<MessageStreamEvent> {
    const startIndex = options?.startIndex ?? this.#state.streamIndex;
    let eventCount = 0;
    try {
      for await (const event of this.#readStream({
        follow: options?.follow,
        signal: options?.signal,
        startIndex,
        streamReconnectPolicy: options?.streamReconnectPolicy,
      })) {
        eventCount += 1;
        yield event;
      }
    } finally {
      if (startIndex >= 0) {
        this.#state = {
          sessionId: this.#state.sessionId,
          streamIndex: startIndex + eventCount,
        };
      }
    }
  }

  #readStream(input: {
    readonly follow?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly startIndex: number;
    readonly streamReconnectPolicy?: StreamOptions["streamReconnectPolicy"];
  }): AsyncIterable<MessageStreamEvent> {
    return followStreamIterable({
      follow: input.follow,
      host: this.#context.host,
      resolveHeaders: () => this.#context.resolveHeaders(input.headers),
      redirect: this.#context.redirect,
      sessionId: this.#state.sessionId,
      signal: input.signal,
      startIndex: input.startIndex,
      streamReconnectPolicy: input.streamReconnectPolicy,
    });
  }
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
        : "Session.send requires a non-empty message, inputResponses, or both.",
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

async function readSessionId(response: Response, expected?: string): Promise<string> {
  const payload = (await response.json()) as Record<string, unknown>;
  const sessionId =
    (typeof payload.sessionId === "string" ? payload.sessionId : undefined) ??
    response.headers.get(EVE_SESSION_ID_HEADER)?.trim() ??
    expected;
  if (!sessionId) throw new Error("Message route did not return a session id.");
  return sessionId;
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
  if (input.clientContext !== undefined) body.clientContext = input.clientContext;
  const outputSchema = serializeOutputSchema(input.outputSchema);
  if (outputSchema !== undefined) body.outputSchema = outputSchema;

  if (requireMessage && body.message === undefined) return null;
  if (body.message === undefined && body.inputResponses === undefined) return null;
  return body;
}
