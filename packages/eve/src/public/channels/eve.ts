import { type FilePart, type TextPart, type UserContent } from "ai";

import type { SessionAuthContext, SessionCallback } from "#channel/types.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_MESSAGE_STREAM_FORMAT,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import { type InputResponse, isInputResponse } from "#runtime/input/types.js";
import { type AuthFn, routeAuth } from "#public/channels/auth.js";
import {
  collectUploadPolicyViolations,
  formatUploadPolicyViolation,
  mergeUploadPolicy,
  type UploadPolicy,
  type UploadPolicyInput,
} from "#public/channels/upload-policy.js";
import {
  defineChannel,
  POST,
  GET,
  type Channel,
  type ChannelEvents,
  type ChannelSessionOps,
} from "#public/definitions/defineChannel.js";
import type { RunMode } from "#shared/run-mode.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

const log = createLogger("eve.channel");

/**
 * Event-handler channel context exposed by `eveChannel({ events })`. The default eve HTTP channel
 * has no platform-specific state, so handlers receive session continuation operations plus the `SessionContext` third arg from {@link ChannelEvents}.
 */
export type EveEventContext = ChannelSessionOps;

/** Runtime stream-event handlers supported by `eveChannel({ events })`. */
export type EveChannelEvents = ChannelEvents<EveEventContext>;

/** Low-level eve HTTP handle exposed to `eveChannel({ onMessage })`. */
export interface EveHandle {
  /** Route-auth result for the request; `onMessage` chooses session auth by returning `{ auth }`. */
  readonly caller: SessionAuthContext | null;
  readonly request: Request;
  /** Existing runtime session id for continuation requests. */
  readonly sessionId?: string;
}

/** Pre-dispatch context passed to `eveChannel({ onMessage })`. */
export interface EveMessageContext {
  readonly eve: EveHandle;
}

/**
 * Result of `eveChannel({ onMessage })`. An object dispatches the inbound message,
 * optionally prepending `context` strings as user messages; `null` accepts without dispatching.
 */
export type EveMessageResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

/** Synchronous or asynchronous `onMessage` result. */
export type EveMessageResultOrPromise = EveMessageResult | Promise<EveMessageResult>;

/**
 * Default `onMessage` auth projection: returns {@link EveHandle.caller} unchanged as the
 * runtime session auth when {@link EveChannelInput.onMessage} is omitted. Call it from a custom `onMessage` to inherit the default while adding `context`.
 */
export function defaultEveAuth(ctx: EveMessageContext): SessionAuthContext | null {
  return ctx.eve.caller;
}

/**
 * Configuration for {@link eveChannel}. Only {@link auth} is required;
 * `uploadPolicy`, `onMessage`, and `events` refine the default HTTP behavior.
 */
export interface EveChannelInput {
  /**
   * Route auth policy: a single {@link AuthFn} or an ordered array walked by {@link routeAuth}.
   * The first entry returning a {@link SessionAuthContext} wins; `null` / `undefined` skips to
   * the next; exhaustion (including the empty array) rejects with 401. Include `none()` last for anonymous traffic.
   */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /**
   * Attachment policy for inbound file parts. Omit for the framework default (25 MB cap, all media
   * types); `"disabled"` rejects every attachment; a partial config is merged onto the default. Violations reject with 413 (too large) or 415 (bad type).
   */
  readonly uploadPolicy?: UploadPolicyInput;
  /**
   * Pre-dispatch hook for inbound eve HTTP messages. Runs after route auth and body
   * parsing, before runtime dispatch.
   */
  readonly onMessage?: (
    ctx: EveMessageContext,
    message: string | UserContent,
  ) => EveMessageResultOrPromise;
  /**
   * Runtime stream-event handlers for the default eve HTTP channel. Handlers receive
   * the event data, {@link EveEventContext}, and `SessionContext` (the same shape as custom channels).
   */
  readonly events?: EveChannelEvents;
}

/**
 * Concrete return type of {@link eveChannel}. Named so consumers can default-export an
 * `eveChannel(...)` call under `declaration: true` without TypeScript falling back to an
 * internal path for `Channel`.
 */
export interface EveChannel extends Channel {}

/**
 * Builds the default eve HTTP channel: a {@link defineChannel} instance serving the
 * built-in `/eve/v1` routes (POST creates a session, POST delivers a follow-up, GET
 * streams a session's NDJSON event feed). Every route runs {@link EveChannelInput.auth}
 * via {@link routeAuth} before dispatching. Default-export the result as your
 * `agent/channels/eve.ts` channel; reach for {@link defineChannel} directly only for a custom transport.
 */
export function eveChannel(input: EveChannelInput): EveChannel {
  const uploadPolicy = mergeUploadPolicy(input.uploadPolicy);

  return defineChannel<undefined, EveEventContext>({
    routes: [
      POST("/eve/v1/session", async (req, { send }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionAuth = authResult;

        let payload: unknown;
        try {
          payload = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
        }

        if (payload === null || typeof payload !== "object") {
          return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
        }

        const body = parseCreateBody(payload as Record<string, unknown>);
        if (body instanceof Response) return body;

        const policyRejection = checkUploadPolicy(body, uploadPolicy);
        if (policyRejection !== null) return policyRejection;

        const messageResult = await resolveOnMessage({
          auth: sessionAuth,
          config: input,
          message: body.message,
          request: req,
        });
        if (messageResult instanceof Response) return messageResult;
        if (!messageResult.dispatch) return droppedMessageResponse();

        const token = `eve:${crypto.randomUUID()}`;
        const context = mergeContext(body.context, messageResult.context);

        const session = await send(createSendPayload(body, context), {
          auth: messageResult.auth,
          callback: body.callback,
          continuationToken: token,
          mode: body.mode,
        });

        return Response.json(
          {
            continuationToken: session.continuationToken,
            ok: true,
            sessionId: session.id,
          },
          {
            headers: {
              "cache-control": "no-store",
              [EVE_SESSION_ID_HEADER]: session.id,
            },
            status: 202,
          },
        );
      }),

      POST("/eve/v1/session/:sessionId", async (req, { send, getSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionAuth = authResult;

        const sessionId = params.sessionId;
        if (!sessionId) {
          return Response.json({ error: "Missing session id.", ok: false }, { status: 400 });
        }

        try {
          getSession(sessionId);
        } catch {
          return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
        }

        let payload: unknown;
        try {
          payload = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
        }

        if (payload === null || typeof payload !== "object") {
          return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
        }

        const body = parseContinueBody(payload as Record<string, unknown>);
        if (body instanceof Response) return body;

        const policyRejection = checkUploadPolicy(body, uploadPolicy);
        if (policyRejection !== null) return policyRejection;

        let context = body.context;
        let dispatchAuth: SessionAuthContext | null = sessionAuth;
        if (body.message !== undefined) {
          const messageResult = await resolveOnMessage({
            auth: sessionAuth,
            config: input,
            message: body.message,
            request: req,
            sessionId,
          });
          if (messageResult instanceof Response) return messageResult;
          if (!messageResult.dispatch) return droppedMessageResponse();
          context = mergeContext(body.context, messageResult.context);
          dispatchAuth = messageResult.auth;
        }

        const session = await send(
          {
            inputResponses: body.inputResponses,
            message: body.message,
            context,
            outputSchema: body.outputSchema,
          },
          {
            auth: dispatchAuth,
            continuationToken: body.continuationToken,
          },
        );

        return Response.json(
          {
            ok: true,
            sessionId: session.id,
          },
          {
            headers: {
              "cache-control": "no-store",
              [EVE_SESSION_ID_HEADER]: session.id,
            },
            status: 200,
          },
        );
      }),

      GET("/eve/v1/session/:sessionId/stream", async (req, { getSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const sessionId = params.sessionId;
        if (!sessionId) {
          return Response.json({ error: "Missing session id.", ok: false }, { status: 400 });
        }

        const startIndex = parseStartIndex(req);
        if (startIndex instanceof Response) return startIndex;

        try {
          const session = getSession(sessionId);
          const events = await session.getEventStream({ startIndex });
          const ndjson = serializeAsNdjson(events);
          return new Response(ndjson, {
            headers: {
              // Opt out of intermediary-proxy buffering. Buffering reverse
              // proxies (notably the Vercel sandbox / v0 preview edge) otherwise
              // withhold this streamed response until it closes, starving the
              // browser of incremental events until a timeout fires.
              "cache-control": "no-store, no-transform",
              "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE,
              "x-accel-buffering": "no",
              [EVE_SESSION_ID_HEADER]: sessionId,
              [EVE_STREAM_FORMAT_HEADER]: EVE_MESSAGE_STREAM_FORMAT,
              [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
            },
          });
        } catch {
          return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
        }
      }),
    ],
    events: input.events,
  });
}

type OnMessageOutcome =
  | {
      readonly auth: SessionAuthContext | null;
      readonly context?: readonly string[];
      readonly dispatch: true;
    }
  | {
      readonly dispatch: false;
    };

async function resolveOnMessage(input: {
  readonly auth: SessionAuthContext | null;
  readonly config: EveChannelInput;
  readonly message: string | UserContent;
  readonly request: Request;
  readonly sessionId?: string;
}): Promise<OnMessageOutcome | Response> {
  const handler = input.config.onMessage ?? defaultOnMessage;

  let result: EveMessageResult | undefined;
  try {
    const eve: EveHandle =
      input.sessionId === undefined
        ? { caller: input.auth, request: input.request }
        : { caller: input.auth, request: input.request, sessionId: input.sessionId };
    const ctx: EveMessageContext = { eve };
    result = await handler(ctx, input.message);
  } catch (error) {
    const errorId = logError(log, "onMessage handler failed", error, {
      sessionId: input.sessionId,
    });
    return Response.json(
      { error: "onMessage handler failed.", errorId, ok: false },
      { status: 500 },
    );
  }

  if (result === null || result === undefined) {
    return { dispatch: false };
  }
  if (result.context === undefined) {
    return { auth: result.auth, dispatch: true };
  }
  return { auth: result.auth, context: result.context, dispatch: true };
}

function defaultOnMessage(ctx: EveMessageContext): Exclude<EveMessageResult, null> {
  return { auth: defaultEveAuth(ctx) };
}

function droppedMessageResponse(): Response {
  return new Response(null, {
    headers: { "cache-control": "no-store" },
    status: 204,
  });
}

interface ParsedCreateBody {
  callback?: SessionCallback;
  message: string | UserContent;
  mode?: RunMode;
  context?: readonly string[];
  outputSchema?: JsonObject;
}

function parseCreateBody(payload: Record<string, unknown>): ParsedCreateBody | Response {
  const message = parseMessageField(payload.message);
  if (message instanceof Response) return message;

  const context = parseClientContextField(payload.clientContext);
  if (context instanceof Response) return context;

  const callback = parseCallbackField(payload.callback);
  if (callback instanceof Response) return callback;

  const mode = parseModeField(payload.mode);
  if (mode instanceof Response) return mode;

  const outputSchema = parseOutputSchemaField(payload.outputSchema);
  if (outputSchema instanceof Response) return outputSchema;

  if (message === undefined) {
    return Response.json(
      { error: "Missing or empty 'message' field.", ok: false },
      { status: 400 },
    );
  }

  return { callback, message, mode, context, outputSchema };
}

interface ParsedContinueBody {
  message?: string | UserContent;
  continuationToken: string;
  inputResponses?: readonly InputResponse[];
  context?: readonly string[];
  outputSchema?: JsonObject;
}

function parseContinueBody(payload: Record<string, unknown>): ParsedContinueBody | Response {
  const continuationToken =
    typeof payload.continuationToken === "string" && payload.continuationToken.length > 0
      ? payload.continuationToken
      : undefined;

  if (continuationToken === undefined) {
    return Response.json(
      { error: "Missing or empty 'continuationToken' field.", ok: false },
      { status: 400 },
    );
  }

  const message = parseMessageField(payload.message);
  if (message instanceof Response) return message;

  const inputResponses = parseInputResponses(payload.inputResponses);
  if (inputResponses instanceof Response) return inputResponses;

  const context = parseClientContextField(payload.clientContext);
  if (context instanceof Response) return context;

  const outputSchema = parseOutputSchemaField(payload.outputSchema);
  if (outputSchema instanceof Response) return outputSchema;

  if (message === undefined && inputResponses === undefined) {
    return Response.json(
      {
        error: "Expected a non-empty 'message', a non-empty 'inputResponses' array, or both.",
        ok: false,
      },
      { status: 400 },
    );
  }

  return { message, continuationToken, inputResponses, context, outputSchema };
}

function createSendPayload(
  body: ParsedCreateBody,
  context = body.context,
):
  | string
  | UserContent
  | {
      readonly message: string | UserContent;
      readonly context?: readonly string[];
      readonly outputSchema?: JsonObject;
    } {
  if (context === undefined && body.outputSchema === undefined) {
    return body.message;
  }
  const payload: {
    message: string | UserContent;
    context?: readonly string[];
    outputSchema?: JsonObject;
  } = { message: body.message };
  if (context !== undefined) {
    payload.context = context;
  }
  if (body.outputSchema !== undefined) {
    payload.outputSchema = body.outputSchema;
  }
  return payload;
}

function parseOutputSchemaField(value: unknown): JsonObject | Response | undefined {
  if (value === undefined) return undefined;

  try {
    return parseJsonObject(value);
  } catch {
    return Response.json(
      { error: "Expected 'outputSchema' to be a JSON-serializable object.", ok: false },
      { status: 400 },
    );
  }
}

function parseCallbackField(value: unknown): SessionCallback | Response | undefined {
  if (value === undefined) return undefined;
  const parsed = parseSessionCallback(value);
  if (parsed.ok) return parsed.callback;

  return Response.json({ error: parsed.message, ok: false }, { status: 400 });
}

function parseModeField(value: unknown): RunMode | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "conversation" || value === "task") return value;
  return Response.json(
    { error: "Expected 'mode' to be either 'conversation' or 'task'.", ok: false },
    { status: 400 },
  );
}

function parseMessageField(value: unknown): string | UserContent | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;

  if (!Array.isArray(value)) {
    return Response.json(
      { error: "Expected 'message' to be a string or an array of text/file parts.", ok: false },
      { status: 400 },
    );
  }

  if (value.length === 0) return undefined;

  const parts: Array<TextPart | FilePart> = [];
  for (const raw of value) {
    const parsed = parseMessagePart(raw);
    if (parsed instanceof Response) return parsed;
    parts.push(parsed);
  }
  return parts;
}

function parseMessagePart(raw: unknown): TextPart | FilePart | Response {
  if (raw === null || typeof raw !== "object") {
    return Response.json(
      { error: "Expected each message part to be an object.", ok: false },
      { status: 400 },
    );
  }

  const part = raw as Record<string, unknown>;
  if (part.type === "text") {
    if (typeof part.text !== "string" || part.text.length === 0) {
      return Response.json(
        { error: "Text parts require a non-empty 'text' string.", ok: false },
        { status: 400 },
      );
    }
    return { type: "text", text: part.text };
  }

  if (part.type === "file") {
    if (typeof part.mediaType !== "string" || part.mediaType.length === 0) {
      return Response.json(
        { error: "File parts require a non-empty 'mediaType' string.", ok: false },
        { status: 400 },
      );
    }
    if (typeof part.data !== "string") {
      return Response.json(
        { error: "File parts require a 'data' string (base64, data URL, or URL).", ok: false },
        { status: 400 },
      );
    }
    // Callers must never supply framework-internal refs (`eve-url:`,
    // `eve-sandbox:`, `eve-attachment:`): the staging pipeline trusts the
    // scheme and would reconstitute the string into a privileged sandbox read.
    if (hasInternalRefScheme(part.data)) {
      return Response.json(
        { error: "File part 'data' must not use a framework-internal ref scheme.", ok: false },
        { status: 400 },
      );
    }
    const filePart: FilePart = { type: "file", mediaType: part.mediaType, data: part.data };
    if (typeof part.filename === "string" && part.filename.length > 0) {
      filePart.filename = part.filename;
    }
    return filePart;
  }

  return Response.json(
    {
      error: `Unsupported message part type "${String(part.type)}". Use 'text' or 'file'.`,
      ok: false,
    },
    { status: 400 },
  );
}

function checkUploadPolicy(
  body: ParsedCreateBody | ParsedContinueBody,
  policy: UploadPolicy,
): Response | null {
  if (!body.message) return null;
  const violations = collectUploadPolicyViolations(body.message, policy);
  if (violations.length === 0) return null;

  const [first] = violations;
  if (!first) return null;

  const status = first.kind === "too-large" ? 413 : 415;
  return Response.json(
    {
      error: formatUploadPolicyViolation(first),
      ok: false,
      violations: violations.map((v) =>
        v.kind === "too-large"
          ? {
              byteLength: v.byteLength,
              filename: v.filename,
              kind: v.kind,
              limit: v.limit,
              mediaType: v.mediaType,
            }
          : {
              allowedMediaTypes: v.allowedMediaTypes,
              filename: v.filename,
              kind: v.kind,
              mediaType: v.mediaType,
            },
      ),
    },
    { status },
  );
}

function parseInputResponses(value: unknown): readonly InputResponse[] | Response | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    return Response.json(
      { error: "Expected 'inputResponses' to be a non-empty array.", ok: false },
      { status: 400 },
    );
  }
  const inputResponses = value.filter(isInputResponse);
  if (inputResponses.length !== value.length) {
    return Response.json(
      {
        error: "Expected every 'inputResponses' entry to match the HITL response schema.",
        ok: false,
      },
      { status: 400 },
    );
  }
  return inputResponses;
}

function mergeContext(
  existing: readonly string[] | undefined,
  added: readonly string[] | undefined,
): readonly string[] | undefined {
  if (existing === undefined) return added;
  if (added === undefined) return existing;
  return [...existing, ...added];
}

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

function parseClientContextField(value: unknown): string[] | Response | undefined {
  if (value === undefined) return undefined;

  if (typeof value === "string") {
    return value.length > 0 ? [toClientContextMessage(value)] : undefined;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;

    if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
      return Response.json(
        { error: "Expected 'clientContext' array entries to be non-empty strings.", ok: false },
        { status: 400 },
      );
    }

    return value.map((entry) => toClientContextMessage(entry));
  }

  if (value === null || typeof value !== "object") {
    return Response.json(
      {
        error: "Expected 'clientContext' to be a string, string array, or JSON object.",
        ok: false,
      },
      { status: 400 },
    );
  }

  try {
    const json = parseJsonObject(value);
    return [toClientContextMessage(JSON.stringify(json))];
  } catch {
    return Response.json(
      { error: "Expected 'clientContext' to be a JSON-serializable object.", ok: false },
      { status: 400 },
    );
  }
}

function toClientContextMessage(content: string): string {
  return `${CLIENT_CONTEXT_PREFIX}${content}`;
}

function parseStartIndex(request: Request): number | undefined | Response {
  const raw = new URL(request.url).searchParams.get("startIndex");
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return Response.json(
      { error: "Expected startIndex to be a non-negative integer.", ok: false },
      { status: 400 },
    );
  }
  return parsed;
}

function serializeAsNdjson(events: ReadableStream<unknown>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return events.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      },
    }),
  );
}
