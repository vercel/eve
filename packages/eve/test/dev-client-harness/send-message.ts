import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/message.js";
import {
  EVE_CREATE_SESSION_ROUTE_PATH,
  createEveContinueSessionRoutePath,
  createEveMessageStreamRoutePath,
} from "#protocol/routes.js";
import {
  createDevelopmentRequestHeadersAsync,
  type DevelopmentRequestHeaders,
} from "./request-headers.js";
import { openDevelopmentMessageStream } from "./live-stream.js";
import {
  createDevelopmentMessageRequest,
  createDevelopmentSessionState,
  type DevelopmentSessionState,
  updateDevelopmentSessionState,
} from "./session.js";
import { extractCurrentTurnBoundaryEvent } from "./stream.js";
import { resolveDevelopmentServerResourceUrl, resolveDevelopmentServerRouteUrl } from "./url.js";

const DEVELOPMENT_TURN_STREAM_RECONNECT_LIMIT = 3;
type MutableDevelopmentRequestHeaders = Headers | Array<[string, string]> | Record<string, string>;

async function fetchDevelopmentSessionStreamResponse(input: {
  readonly headers?: DevelopmentRequestHeaders;
  readonly sessionId: string;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly startIndex?: number;
}): Promise<{
  readonly resourceUrl: string;
  readonly response: Response;
}> {
  const canonicalResourceUrl = resolveDevelopmentServerResourceUrl({
    resource: createEveMessageStreamRoutePath(input.sessionId),
    serverUrl: input.serverUrl,
  });
  const requestResourceUrl = new URL(canonicalResourceUrl);

  if (input.startIndex !== undefined) {
    requestResourceUrl.searchParams.set("startIndex", String(input.startIndex));
  }

  const streamResponse = await fetch(requestResourceUrl, {
    headers: await createDevelopmentRequestHeadersAsync({
      headers: input.headers,
      resourceUrl: requestResourceUrl,
    }),
    signal: input.signal ?? null,
  });

  if (!streamResponse.ok) {
    const body = await streamResponse.text();
    throw new Error(body || `Session stream route returned ${streamResponse.status}.`);
  }

  return {
    resourceUrl: canonicalResourceUrl.toString(),
    response: streamResponse,
  };
}

async function openDevelopmentSessionStream(input: {
  readonly headers?: DevelopmentRequestHeaders;
  readonly sessionId: string;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly startIndex?: number;
}): Promise<ReturnType<typeof openDevelopmentMessageStream>> {
  const streamResponse = await fetchDevelopmentSessionStreamResponse(input);

  return openDevelopmentMessageStream({
    resourceUrl: streamResponse.resourceUrl,
    response: streamResponse.response,
  });
}

async function readDevelopmentTurnEvents(input: {
  readonly headers?: DevelopmentRequestHeaders;
  readonly initialStartIndex: number;
  onEvent?(event: HandleMessageStreamEvent): void;
  readonly sessionId: string;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly stream: ReturnType<typeof openDevelopmentMessageStream>;
}): Promise<{
  readonly events: HandleMessageStreamEvent[];
  readonly stream: ReturnType<typeof openDevelopmentMessageStream>;
}> {
  let currentStream = input.stream;
  const events: HandleMessageStreamEvent[] = [];
  let currentStreamIndex = input.initialStartIndex;
  let remainingReconnectAttempts = DEVELOPMENT_TURN_STREAM_RECONNECT_LIMIT;

  while (true) {
    const nextEvents = await currentStream.readEvents({
      onEvent: input.onEvent,
    });

    events.push(...nextEvents);
    currentStreamIndex += nextEvents.length;

    if (extractCurrentTurnBoundaryEvent(nextEvents)) {
      return {
        events,
        stream: currentStream,
      };
    }

    if (!currentStream.closed || remainingReconnectAttempts === 0) {
      return {
        events,
        stream: currentStream,
      };
    }

    remainingReconnectAttempts -= 1;
    await currentStream.close();
    currentStream = await openDevelopmentSessionStream({
      headers: input.headers,
      sessionId: input.sessionId,
      signal: input.signal,
      serverUrl: input.serverUrl,
      startIndex: currentStreamIndex,
    });
  }
}

/**
 * Sends one message to the configured eve server and collects its streamed
 * events, forwarding any caller-supplied eve route headers across the message
 * and stream requests for the current turn.
 */
export async function sendDevelopmentMessage(input: {
  headers?: DevelopmentRequestHeaders;
  message: string;
  onEvent?(event: HandleMessageStreamEvent): void;
  onResponseStart?(response: { sessionId?: string }): void;
  signal?: AbortSignal;
  session: DevelopmentSessionState;
  serverUrl: string;
}): Promise<{
  completedMessage?: string;
  events: HandleMessageStreamEvent[];
  sessionId?: string;
  session: DevelopmentSessionState;
}> {
  const session = input.session;
  const routePath = session.sessionId
    ? createEveContinueSessionRoutePath(session.sessionId)
    : EVE_CREATE_SESSION_ROUTE_PATH;
  const messageRouteUrl = resolveDevelopmentServerRouteUrl({
    routePath,
    serverUrl: input.serverUrl,
  });
  let stream: ReturnType<typeof openDevelopmentMessageStream> | undefined;

  try {
    const response = await fetch(messageRouteUrl, {
      body: JSON.stringify(
        createDevelopmentMessageRequest({
          message: input.message,
          session,
        }),
      ),
      headers: await createDevelopmentRequestHeadersAsync({
        headers: createMessageRouteHeaders(input.headers),
        resourceUrl: messageRouteUrl,
      }),
      method: "POST",
      signal: input.signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `Message route returned ${response.status}.`);
    }

    const payload = (await response.json()) as Record<string, unknown>;

    if (payload.status === "completed" && typeof payload.output === "string") {
      const continuationToken =
        typeof payload.continuationToken === "string" ? payload.continuationToken : undefined;

      return {
        completedMessage: payload.output,
        events: [],
        session: createDevelopmentSessionState({ continuationToken }),
      };
    }

    const sessionId =
      (typeof payload.sessionId === "string" ? payload.sessionId : undefined) ??
      response.headers.get(EVE_SESSION_ID_HEADER)?.trim() ??
      session.sessionId ??
      undefined;
    const continuationToken =
      typeof payload.continuationToken === "string"
        ? payload.continuationToken
        : session.continuationToken;

    if (!sessionId) {
      throw new Error("Message route did not return a session id.");
    }

    input.onResponseStart?.({
      sessionId,
    });

    stream = await openDevelopmentSessionStream({
      headers: input.headers,
      sessionId,
      signal: input.signal,
      serverUrl: input.serverUrl,
      startIndex: session.sessionId === sessionId ? session.streamIndex : undefined,
    });

    const readResult = await readDevelopmentTurnEvents({
      headers: input.headers,
      initialStartIndex: session.sessionId === sessionId ? session.streamIndex : 0,
      onEvent: input.onEvent,
      sessionId,
      signal: input.signal,
      serverUrl: input.serverUrl,
      stream,
    });
    const events = readResult.events;
    stream = readResult.stream;

    if (!extractCurrentTurnBoundaryEvent(events)) {
      await stream.close();

      throw new Error(
        "Development message stream closed before the current turn reached a boundary.",
      );
    }

    const nextSession = updateDevelopmentSessionState({
      continuationToken,
      events,
      sessionId,
      session,
    });

    await stream.close();

    return {
      events,
      sessionId,
      session: nextSession,
    };
  } catch (error) {
    await stream?.close().catch(() => undefined);

    throw error;
  }
}

function createMessageRouteHeaders(headers?: DevelopmentRequestHeaders): DevelopmentRequestHeaders {
  const resolvedHeaders = new Headers(copyDevelopmentRequestHeaders(headers));
  resolvedHeaders.set("content-type", "application/json");
  return resolvedHeaders;
}

function copyDevelopmentRequestHeaders(
  headers?: DevelopmentRequestHeaders,
): MutableDevelopmentRequestHeaders | undefined {
  if (headers === undefined) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers;
  }

  if (Array.isArray(headers)) {
    return headers.map(([key, value]): [string, string] => [key, value]);
  }

  return headers as Record<string, string>;
}
