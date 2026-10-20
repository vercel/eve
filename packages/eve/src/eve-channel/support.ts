import type { UserContent } from "ai";

import { SessionStrandedError } from "#channel/session-stranded-error.js";
import type { SessionAuthContext } from "#channel/types.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type { ChannelCors } from "#public/definitions/channel.js";
import {
  type ClientContextValue,
  defaultEveAuth,
  type EveChannelCors,
  type EveChannelCorsOptions,
  type EveChannelInput,
  type EveHandle,
  type EveMessageContext,
  type EveMessageResult,
} from "#eve-channel/types.js";

const log = createLogger("eve.channel");

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

export function healthResponse(): Response {
  return Response.json({
    ok: true,
    status: "ready",
    workflowId: workflowEntryReference.workflowId,
  });
}

/** Clients display the error text directly; keep operator details in structured fields. */
export function strandedSessionResponse(error: unknown): Response | undefined {
  if (!SessionStrandedError.is(error)) return undefined;
  const body: Record<string, unknown> = {
    code: "session_stranded",
    error: "This session is no longer available.",
    ok: false,
  };
  if (error.owner.eveVersion !== undefined) body.eveVersion = error.owner.eveVersion;
  return Response.json(body, { headers: { "cache-control": "no-store" }, status: 409 });
}

/** Where a remote child the parent session recorded runs, and its credential key. */
export interface RemoteAgentBinding {
  readonly forwardPrincipal?: boolean;
  readonly name: string;
  readonly resolverId?: string;
  readonly url: string;
  /** The child's remote agent protocol, when it speaks an earlier one. */
  readonly earlierProtocol?: number;
}

interface RemoteAgentStreamCoordinates {
  readonly callId: string;
  readonly childSessionId: string;
  readonly childStreamPath: string;
}

/** Finds the remote child the parent session recorded for one proxy route, from its private binding. */
export async function findRemoteAgentBinding(
  input: RemoteAgentStreamCoordinates & {
    readonly parent: {
      getChildBinding?(childSessionId: string): Promise<
        | {
            readonly callId: string;
            readonly name: string;
            readonly resolverId?: string;
            readonly streamPath: string;
            readonly url: string;
            readonly earlierProtocol?: number;
          }
        | undefined
      >;
    };
  },
): Promise<RemoteAgentBinding | undefined> {
  const recorded = await input.parent.getChildBinding?.(input.childSessionId);
  // The stream path embeds the parent session id, so matching it binds the parent.
  if (
    recorded === undefined ||
    recorded.callId !== input.callId ||
    recorded.streamPath !== input.childStreamPath
  )
    return undefined;
  const binding: { -readonly [K in keyof RemoteAgentBinding]: RemoteAgentBinding[K] } = {
    name: recorded.name,
    url: recorded.url,
  };
  if (recorded.resolverId !== undefined) binding.resolverId = recorded.resolverId;
  if (recorded.earlierProtocol !== undefined) binding.earlierProtocol = recorded.earlierProtocol;
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
  /** Model-ready turn context: `onMessage`'s replacement, or the request's labeled entries. */
  readonly clientContext?: readonly string[];
  readonly context?: readonly string[];
  readonly title?: string;
}

export async function resolveOnMessage(input: {
  readonly auth: SessionAuthContext | null;
  readonly clientContext?: ClientContextValue;
  readonly config: EveChannelInput;
  readonly invocation?: EveHandle["invocation"];
  readonly message: string | UserContent;
  readonly request: Request;
  readonly sessionId?: string;
}): Promise<OnMessageOutcome | Response> {
  const handler = input.config.onMessage ?? defaultOnMessage;

  let result: EveMessageResult;
  try {
    const base: EveHandle = {
      caller: input.auth,
      clientContext: input.clientContext,
      request: input.request,
    };
    const eve: EveHandle =
      input.sessionId === undefined
        ? input.invocation === undefined
          ? base
          : { ...base, invocation: input.invocation }
        : { ...base, sessionId: input.sessionId };
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

  return {
    auth: result.auth,
    clientContext: resolveTurnClientContext(result.clientContext, input.clientContext),
    context: result.context,
    title: result.title,
  };
}

/**
 * The turn's model context messages: `onMessage`'s replacement as written, otherwise
 * the request's entries labeled as client-supplied. Empty means none.
 */
export function resolveTurnClientContext(
  replacement: ClientContextValue | undefined,
  requested: ClientContextValue | undefined,
): readonly string[] | undefined {
  const messages =
    replacement === undefined
      ? toContextEntries(requested).map((entry) => `${CLIENT_CONTEXT_PREFIX}${entry}`)
      : toContextEntries(replacement);
  return messages.length === 0 ? undefined : messages;
}

/** One model message per string; an object is JSON-serialized into one. */
function toContextEntries(value: ClientContextValue | undefined): readonly string[] {
  if (value === undefined || value === "") return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [JSON.stringify(value)];
}

function defaultOnMessage(ctx: EveMessageContext): EveMessageResult {
  return { auth: defaultEveAuth(ctx) };
}
