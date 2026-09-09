import type { UserContent } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { holdingWorkflowReference } from "#execution/workflow-references.js";
import { createLogger, logError } from "#internal/logging.js";
import type { MessageStreamEvent, SubagentCalledStreamEvent } from "#protocol/message.js";
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
    workflowId: holdingWorkflowReference.workflowId,
  });
}

export async function findRemoteSubagentBinding(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly childStreamPath: string;
  readonly parentSessionId: string;
  readonly parent: {
    getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<MessageStreamEvent>>;
    getStreamTailIndex(): Promise<number>;
  };
}): Promise<SubagentCalledStreamEvent | undefined> {
  const tailIndex = await input.parent.getStreamTailIndex();
  if (tailIndex < 0) return undefined;

  const events = await input.parent.getEventStream({ startIndex: 0 });
  const reader = events.getReader();
  let binding: SubagentCalledStreamEvent | undefined;
  try {
    for (let index = 0; index <= tailIndex; index += 1) {
      const next = await reader.read();
      if (next.done) break;
      const event = next.value;
      if (
        event.type === "subagent.called" &&
        event.data.sessionId === input.parentSessionId &&
        event.data.callId === input.callId &&
        event.data.childSessionId === input.childSessionId &&
        event.data.childStreamPath === input.childStreamPath &&
        event.data.remote !== undefined
      ) {
        binding = event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return binding;
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

export function normalizeEveCorsOrigin(
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

export function defaultOnMessage(ctx: EveMessageContext): EveMessageResult {
  return { auth: defaultEveAuth(ctx) };
}
