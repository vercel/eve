import type { UserContent } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { ChannelCors } from "#public/definitions/channel.js";
import {
  defaultEveAuth,
  type EveChannelCors,
  type EveChannelCorsOptions,
  type EveChannelInput,
  type EveHandle,
  type EveMessageContext,
  type EveMessageResult,
} from "#eve-channel/types.js";

const log = createLogger("eve.channel");

export function healthResponse(): Response {
  return Response.json({
    ok: true,
    status: "ready",
    workflowId: workflowEntryReference.workflowId,
  });
}

/** Where a remote child the parent session recorded runs, and its credential key. */
export interface RemoteAgentBinding {
  readonly name: string;
  readonly resolverId?: string;
  readonly url: string;
}

interface RemoteAgentStreamCoordinates {
  readonly callId: string;
  readonly childSessionId: string;
  readonly childStreamPath: string;
  readonly parentSessionId: string;
}

/**
 * Finds the remote child the parent session recorded for one proxy route, from
 * its `agent.started` event or, for the model's agent tools, `subagent.called`.
 */
export async function findRemoteAgentBinding(
  input: RemoteAgentStreamCoordinates & {
    readonly parent: {
      getEventStream(options?: {
        startIndex?: number;
      }): Promise<ReadableStream<MessageStreamEvent>>;
      getStreamTailIndex(): Promise<number>;
    };
  },
): Promise<RemoteAgentBinding | undefined> {
  const tailIndex = await input.parent.getStreamTailIndex();
  if (tailIndex < 0) return undefined;

  const events = await input.parent.getEventStream({ startIndex: 0 });
  const reader = events.getReader();
  let binding: RemoteAgentBinding | undefined;
  try {
    for (let index = 0; index <= tailIndex; index += 1) {
      const next = await reader.read();
      if (next.done) break;
      binding = readRemoteAgentBinding(next.value, input) ?? binding;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return binding;
}

function readRemoteAgentBinding(
  event: MessageStreamEvent,
  coordinates: RemoteAgentStreamCoordinates,
): RemoteAgentBinding | undefined {
  if (event.type === "agent.started") {
    const { data } = event;
    // The stream path embeds the parent session id, so matching it binds the parent.
    const matches =
      data.callId === coordinates.callId &&
      data.sessionId === coordinates.childSessionId &&
      data.streamPath === coordinates.childStreamPath;
    if (!matches || data.remote === undefined) return undefined;
    return { name: data.name, ...data.remote };
  }
  if (event.type === "subagent.called") {
    const { data } = event;
    const matches =
      data.sessionId === coordinates.parentSessionId &&
      data.callId === coordinates.callId &&
      data.childSessionId === coordinates.childSessionId &&
      data.childStreamPath === coordinates.childStreamPath;
    if (!matches || data.remote === undefined) return undefined;
    return { name: data.toolName, ...data.remote };
  }
  return undefined;
}

export function normalizeEveCors(cors: EveChannelCors | undefined): ChannelCors {
  if (cors === undefined || cors === false) {
    return false;
  }
  if (cors === true) {
    return true;
  }

  const result: {
    origin?: "*" | "null" | readonly string[];
    methods?: "*" | readonly string[];
    allowHeaders?: "*" | readonly string[];
    exposeHeaders?: "*" | readonly string[];
    credentials?: boolean;
    maxAge?: number | false;
    preflight?: {
      statusCode?: number;
    };
  } = {};

  if (cors.origin !== undefined) {
    result.origin = normalizeEveCorsOrigin(cors.origin);
  }
  if (cors.methods !== undefined) {
    result.methods = cors.methods;
  }
  if (cors.allowedHeaders !== undefined) {
    result.allowHeaders = cors.allowedHeaders;
  }
  if (cors.exposedHeaders !== undefined) {
    result.exposeHeaders = cors.exposedHeaders;
  }
  if (cors.credentials !== undefined) {
    result.credentials = cors.credentials;
  }
  if (cors.maxAge !== undefined) {
    result.maxAge = cors.maxAge;
  }
  if (cors.preflightStatus !== undefined) {
    result.preflight = { statusCode: cors.preflightStatus };
  }

  return result;
}

function normalizeEveCorsOrigin(
  origin: NonNullable<EveChannelCorsOptions["origin"]>,
): "*" | "null" | readonly string[] {
  if (origin === "*" || origin === "null") {
    return origin;
  }
  if (typeof origin === "string") {
    return [origin];
  }
  return origin;
}

interface OnMessageOutcome {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly title?: string;
}

export async function resolveOnMessage(input: {
  readonly auth: SessionAuthContext | null;
  readonly config: EveChannelInput;
  readonly message: string | UserContent;
  readonly request: Request;
  readonly sessionId?: string;
}): Promise<OnMessageOutcome | Response> {
  const handler = input.config.onMessage ?? defaultOnMessage;

  let result: EveMessageResult;
  try {
    const eve: EveHandle =
      input.sessionId === undefined
        ? { caller: input.auth, request: input.request }
        : { caller: input.auth, request: input.request, sessionId: input.sessionId };
    const ctx: EveMessageContext = { eve };
    result = await handler(ctx, input.message);
    if (result === null || result === undefined) {
      throw new TypeError("eveChannel onMessage must return an auth result.");
    }
  } catch (error) {
    const errorId = logError(log, "onMessage handler failed", error, {
      sessionId: input.sessionId,
    });
    return Response.json(
      { error: "onMessage handler failed.", errorId, ok: false },
      { status: 500 },
    );
  }

  return { auth: result.auth, context: result.context, title: result.title };
}

function defaultOnMessage(ctx: EveMessageContext): EveMessageResult {
  return { auth: defaultEveAuth(ctx) };
}
