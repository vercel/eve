import { type FilePart, type TextPart, type UserContent } from "ai";

import type {
  SessionAuthContext,
  SessionCallback,
  SessionCapabilities,
  TurnPolicy,
} from "#channel/types.js";
import type { CancelTurnResponse } from "#protocol/cancel-turn.js";
import type { ClearResponse } from "#protocol/clear-session.js";
import type { CompactResponse } from "#protocol/compact-session.js";
import type { ResetResponse } from "#protocol/reset-session.js";
import type { Session } from "#channel/session.js";
import { resolveForwardedPrincipal, type TrustedForwarders } from "#channel/forwarded-principal.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  readAgentInfoRouteResponse,
  readRemoteAgentStreamHeadersResolver,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_MESSAGE_STREAM_FORMAT,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
  type MessageStreamEvent,
  type SubagentCalledStreamEvent,
} from "#protocol/message.js";
import { parseTraceparent } from "#protocol/traceparent.js";
import {
  EVE_CALLBACK_ROUTE_PATTERN,
  EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
  EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_SESSION_ROUTE_PATH,
  EVE_SESSION_CANCEL_ROUTE_PATTERN,
  EVE_SESSION_CLEAR_ROUTE_PATTERN,
  EVE_SESSION_COMPACT_ROUTE_PATTERN,
  EVE_SESSION_ROUTE_PATTERN,
  EVE_SESSION_RESET_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
  EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
  EVE_TASK_INPUT_ROUTE_PATTERN,
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import {
  handleConnectionCallbackRequest,
  handleLegacyConnectionCallbackRequest,
} from "#runtime/connections/callback-route.js";
import { handleSessionCallbackRequest } from "#runtime/session-callback-route.js";
import { handleTaskInputResponseRequest } from "#runtime/task-input-response-route.js";
import { buildEveHealthResponse } from "#runtime/health.js";
import { isInputResponse, type ValidatedInputResponse } from "#runtime/input/types.js";
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
  HEAD,
  POST,
  GET,
  type Channel,
  type ChannelCors,
  type ChannelEvents,
  type ChannelContinuationOps,
} from "#public/definitions/channel.js";
import type { ChannelMethod } from "#public/definitions/channel.js";
import type { RunMode } from "#shared/run-mode.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

const log = createLogger("eve.channel");

/**
 * Event-handler channel context exposed by `eveChannel({ events })`. The default eve HTTP channel
 * has no platform-specific state, so handlers receive optional continuation routing here and the
 * `SessionContext` third argument from {@link ChannelEvents}.
 */
export type EveEventContext = ChannelContinuationOps;

/** Runtime stream-event handlers supported by `eveChannel({ events })`. */
export type EveChannelEvents = ChannelEvents<EveEventContext>;

export interface EveChannelCorsOptions {
  /**
   * Allowed request origin. Pass a single origin string, an exact-origin list,
   * `"null"`, or `"*"`. Omit for `"*"`.
   */
  readonly origin?: "*" | "null" | string | readonly string[];
  /** Methods emitted on preflight responses. Omit for `"*"`. */
  readonly methods?: "*" | readonly ChannelMethod[];
  /** Request headers emitted on preflight responses. Omit for `"*"`. */
  readonly allowedHeaders?: "*" | readonly string[];
  /** Response headers exposed to browser callers. Omit for `"*"`. */
  readonly exposedHeaders?: "*" | readonly string[];
  /** Whether to emit `access-control-allow-credentials: true`. */
  readonly credentials?: boolean;
  /** Max age, in seconds, emitted on preflight responses. */
  readonly maxAge?: number | false;
  /** Preflight response status code. Defaults to 204. */
  readonly preflightStatus?: number;
}

/**
 * Higher-level CORS policy for the default eve HTTP channel. Pass `true` for
 * fully permissive browser access, or pass an options object to narrow it.
 */
export type EveChannelCors = boolean | EveChannelCorsOptions;

/** Low-level eve HTTP handle exposed to `eveChannel({ onMessage })`. */
export interface EveHandle {
  /** Route-auth result for the request; `onMessage` chooses session auth by returning `{ auth }`. */
  readonly caller: SessionAuthContext | null;
  readonly request: Request;
  /** Existing runtime session id for follow-up requests. */
  readonly sessionId?: string;
}

/** Pre-dispatch context passed to `eveChannel({ onMessage })`. */
export interface EveMessageContext {
  readonly eve: EveHandle;
}

/**
 * Result of `eveChannel({ onMessage })`. The object dispatches the inbound message,
 * optionally prepending `context` strings as user messages.
 */
export type EveMessageResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  /** Overrides the workflow run title without changing the message sent to the model. */
  readonly title?: string;
};

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
   * The trusted-forwarders policy: which transport-authenticated callers may
   * assert a forwarded principal on the create-session or continuation route (the
   * `forwardedPrincipal` body field a `defineRemoteAgent({ forwardPrincipal:
   * true })` sender emits). The predicate receives the *verified* route-auth
   * principal of the forwarder — who is asserting, never what is asserted —
   * and must match it precisely (for example
   * `(forwarder) => forwarder.subject === vercelSubject({ teamSlug, projectName })`).
   * A permissive predicate lets any authenticated forwarder assert any
   * principal.
   *
   * When a trusted forwarder's assertion is accepted on session creation, the
   * forwarded principal replaces `session.auth.current` and
   * `session.auth.initiator`. On continuation, only `session.auth.current`
   * changes; the initiator remains pinned to the session's creator. The
   * forwarder is recorded on accepted contexts as the `eve:forwarded-by`
   * attribute. Omit the option to reject every forwarded assertion with 403.
   */
  readonly trustedForwarders?: TrustedForwarders;
  /**
   * Attachment policy for inbound file parts. Omit for the framework default (25 MB cap, all media
   * types); `"disabled"` rejects every attachment; a partial config is merged onto the default. Violations reject with 413 (too large) or 415 (bad type).
   */
  readonly uploadPolicy?: UploadPolicyInput;
  /**
   * Browser CORS policy for the eve HTTP routes. Omit or pass `false` to leave
   * CORS untouched, pass `true` for fully permissive CORS, or pass an options
   * object to narrow the policy.
   */
  readonly cors?: EveChannelCors;
  /** Policy for follow-up messages that arrive while a turn is active. */
  readonly turnPolicy?: TurnPolicy;
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
 * built-in `/eve/v1` routes (GET inspects the agent, POST creates a session,
 * ID-addressed POST routes deliver follow-ups and controls, and GET streams a
 * session's NDJSON event feed). Every route
 * runs {@link EveChannelInput.auth} via {@link routeAuth} before dispatching.
 * Default-export the result as your `agent/channels/eve.ts` channel; reach for
 * {@link defineChannel} directly only for a custom transport.
 */
export function eveChannel(input: EveChannelInput): EveChannel {
  const uploadPolicy = mergeUploadPolicy(input.uploadPolicy);

  return defineChannel<undefined, EveEventContext>({
    cors: normalizeEveCors(input.cors),
    turnPolicy: input.turnPolicy,
    routes: [
      // The health route is intentionally always-public so platform load
      // balancers and uptime monitors can probe it without credentials.
      // Replacing this channel replaces the health contract too;
      // `Client.health()` validates the payload shape client-side.
      GET(EVE_HEALTH_ROUTE_PATH, async () => buildEveHealthResponse()),
      HEAD(EVE_HEALTH_ROUTE_PATH, async () => buildEveHealthResponse()),

      // Connection authorization callbacks. Unauthenticated by design: an
      // OAuth IdP follows these URLs via browser redirects with no eve
      // credentials attached; the unguessable token authorizes the resume.
      GET(EVE_CONNECTION_CALLBACK_ROUTE_PATTERN, handleConnectionCallbackRequest),
      POST(EVE_CONNECTION_CALLBACK_ROUTE_PATTERN, handleConnectionCallbackRequest),
      GET(EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN, handleLegacyConnectionCallbackRequest),
      POST(EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN, handleLegacyConnectionCallbackRequest),

      // Terminal session callback: `:token` is an unguessable workflow hook
      // capability minted by the framework.
      POST(EVE_CALLBACK_ROUTE_PATTERN, handleSessionCallbackRequest),

      // Capability route used by a parent task to answer a remote child
      // HITL batch.
      POST(EVE_TASK_INPUT_ROUTE_PATTERN, handleTaskInputResponseRequest),

      GET(EVE_INFO_ROUTE_PATH, async (req, args) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const respond = readAgentInfoRouteResponse(args);
        if (respond === undefined) {
          return Response.json(
            { error: "Agent info route requires internal channel dispatch context.", ok: false },
            { status: 500 },
          );
        }

        return await respond();
      }),

      POST(EVE_SESSION_ROUTE_PATH, async (req, args) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const payload = await parseJsonRequest(req);
        if (payload instanceof Response) return payload;
        const tokenRejection = rejectSessionContinuationToken(payload);
        if (tokenRejection !== null) return tokenRejection;

        const forwarded = await resolveForwardedPrincipal({
          trustedForwarders: input.trustedForwarders,
          forwarder: authResult,
          payload,
        });
        if (forwarded instanceof Response) return forwarded;

        const body = parseCreateBody(payload);
        if (body instanceof Response) return body;
        // Top-level sessions own their trace. Callback sessions are delegated
        // remote agents and intentionally continue the dispatching agent trace.
        const parentTraceContext =
          body.callback === undefined
            ? undefined
            : parseTraceparent(req.headers.get("traceparent"));

        const policyRejection = checkUploadPolicy(body, uploadPolicy);
        if (policyRejection !== null) return policyRejection;

        if (body.operationId !== undefined && forwarded.auth.principalType === "anonymous") {
          return Response.json(
            { error: "operationId requires an authenticated principal.", ok: false },
            { status: 400 },
          );
        }
        const operationToken =
          body.operationId === undefined
            ? undefined
            : await deriveOperationContinuationToken({
                auth: forwarded.auth,
                operationId: body.operationId,
              });
        if (operationToken !== undefined) {
          const owner = await args.resolveSession(operationToken);
          if (owner !== undefined) {
            return Response.json(
              { ok: true, sessionId: owner.id, status: "accepted" },
              {
                headers: {
                  "cache-control": "no-store",
                  [EVE_SESSION_ID_HEADER]: owner.id,
                },
                status: 202,
              },
            );
          }
        }

        const messageResult = await resolveOnMessage({
          auth: forwarded.auth,
          config: input,
          message: body.message,
          request: req,
        });
        if (messageResult instanceof Response) return messageResult;
        const createSession = readRouteSessionCreator(args);
        if (createSession === undefined) {
          return Response.json(
            { error: "Session creation requires internal channel dispatch context.", ok: false },
            { status: 500 },
          );
        }

        let handle: Awaited<ReturnType<typeof createSession>>;
        try {
          handle = await createSession({
            auth: messageResult.auth,
            capabilities:
              body.capabilities ?? (body.mode === "task" ? undefined : { requestInput: true }),
            callback: body.callback,
            continuationToken: operationToken,
            initiatorAuth: forwarded.accepted ? forwarded.initiatorAuth : undefined,
            input: {
              message: body.message,
              context: mergeContext(body.context, messageResult.context),
              outputSchema: body.outputSchema,
            },
            mode: body.mode ?? "conversation",
            parentTraceContext,
            title: messageResult.title,
          });
        } catch (error) {
          // A concurrent create-once request won the token: adopt its session
          // without delivering this duplicate input.
          if (operationToken !== undefined && isRuntimeSessionOwnershipConflictError(error)) {
            return Response.json(
              { ok: true, sessionId: error.ownerSessionId, status: "accepted" },
              {
                headers: {
                  "cache-control": "no-store",
                  [EVE_SESSION_ID_HEADER]: error.ownerSessionId,
                },
                status: 202,
              },
            );
          }
          const errorId = logError(log, "session-create request failed", error);
          return Response.json(
            { error: "Failed to create the session.", errorId, ok: false },
            { status: 500 },
          );
        }

        return Response.json(
          { ok: true, sessionId: handle.sessionId, status: "accepted" },
          {
            headers: {
              "cache-control": "no-store",
              [EVE_SESSION_ID_HEADER]: handle.sessionId,
            },
            status: 202,
          },
        );
      }),

      POST(EVE_SESSION_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        const payload = await parseJsonRequest(req);
        if (payload instanceof Response) return payload;
        const forwarded = await resolveForwardedPrincipal({
          trustedForwarders: input.trustedForwarders,
          forwarder: authResult,
          payload,
        });
        if (forwarded instanceof Response) return forwarded;
        const body = parseSessionMessageBody(payload);
        if (body instanceof Response) return body;

        const policyRejection = checkUploadPolicy(body, uploadPolicy);
        if (policyRejection !== null) return policyRejection;

        let context = body.context;
        let dispatchAuth: SessionAuthContext | null = forwarded.auth;
        if (body.message !== undefined) {
          const messageResult = await resolveOnMessage({
            auth: forwarded.auth,
            config: input,
            message: body.message,
            request: req,
            sessionId,
          });
          if (messageResult instanceof Response) return messageResult;
          context = mergeContext(body.context, messageResult.context);
          dispatchAuth = messageResult.auth;
        }

        let result: Awaited<ReturnType<Session["send"]>>;
        try {
          const session = attachSession(sessionId);
          const options = {
            auth: dispatchAuth,
            callback: body.callback,
            context,
            outputSchema: body.outputSchema,
            turnPolicy: body.turnPolicy,
          };
          result =
            body.inputResponses === undefined
              ? await session.send(body.message!, options)
              : await session.respond(body.inputResponses, options);
        } catch (error) {
          const errorId = logError(log, "session-message request failed", error, { sessionId });
          return Response.json(
            { error: "Failed to send the session message.", errorId, ok: false },
            { status: 500 },
          );
        }
        if (result.status === "session_not_active") {
          return Response.json(
            {
              code: "session_not_active",
              error: "The session is no longer active.",
              ok: false,
            },
            { headers: { "cache-control": "no-store" }, status: 409 },
          );
        }

        return Response.json(
          { ok: true, sessionId: result.sessionId, status: "accepted" },
          {
            headers: {
              "cache-control": "no-store",
              [EVE_SESSION_ID_HEADER]: result.sessionId,
            },
            status: 202,
          },
        );
      }),

      POST(EVE_SESSION_CANCEL_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        const body = await parseCancelTurnBody(req);
        if (body instanceof Response) return body;
        let result: Awaited<ReturnType<Session["cancel"]>>;
        try {
          result = await attachSession(sessionId).cancel({
            taskId: body.taskId,
            turnId: body.turnId,
          });
        } catch (error) {
          const errorId = logError(log, "cancel-turn request failed", error, { sessionId });
          return Response.json(
            { error: "Failed to cancel the turn.", errorId, ok: false },
            { status: 500 },
          );
        }
        return Response.json(
          result.status === "accepted"
            ? ({
                ok: true,
                sessionId: result.sessionId,
                status: "accepted",
              } satisfies CancelTurnResponse)
            : ({ ok: true, status: "no_active_turn" } satisfies CancelTurnResponse),
          {
            headers: { "cache-control": "no-store" },
            status: result.status === "accepted" ? 202 : 200,
          },
        );
      }),

      POST(EVE_SESSION_COMPACT_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        const body = await parseSessionControlBody(req);
        if (body instanceof Response) return body;
        let result: Awaited<ReturnType<Session["compact"]>>;
        try {
          result = await attachSession(sessionId).compact();
        } catch (error) {
          const errorId = logError(log, "session-compaction request failed", error, { sessionId });
          return Response.json(
            { error: "Failed to compact the session.", errorId, ok: false },
            { status: 500 },
          );
        }
        return Response.json(
          result.status === "accepted"
            ? ({
                ok: true,
                sessionId: result.sessionId,
                status: "accepted",
              } satisfies CompactResponse)
            : ({ ok: true, status: "no_active_session" } satisfies CompactResponse),
          {
            headers: { "cache-control": "no-store" },
            status: result.status === "accepted" ? 202 : 200,
          },
        );
      }),

      POST(EVE_SESSION_CLEAR_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        const body = await parseSessionControlBody(req);
        if (body instanceof Response) return body;
        let result: Awaited<ReturnType<Session["clear"]>>;
        try {
          result = await attachSession(sessionId).clear();
        } catch (error) {
          const errorId = logError(log, "session-clear request failed", error, { sessionId });
          return Response.json(
            { error: "Failed to clear the session context.", errorId, ok: false },
            { status: 500 },
          );
        }
        return Response.json(
          result.status === "accepted"
            ? ({
                ok: true,
                sessionId: result.sessionId,
                status: "accepted",
              } satisfies ClearResponse)
            : ({ ok: true, status: "no_active_session" } satisfies ClearResponse),
          {
            headers: { "cache-control": "no-store" },
            status: result.status === "accepted" ? 202 : 200,
          },
        );
      }),

      POST(EVE_SESSION_RESET_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        const body = await parseResetBody(req);
        if (body instanceof Response) return body;
        let result: Awaited<ReturnType<Session["reset"]>>;
        try {
          result = await attachSession(sessionId).reset({ reason: body.reason });
        } catch (error) {
          const errorId = logError(log, "session-reset request failed", error, { sessionId });
          return Response.json(
            { error: "Failed to reset the session.", errorId, ok: false },
            { status: 500 },
          );
        }
        return Response.json(
          result.status === "reset"
            ? ({
                ok: true,
                previousSessionId: result.previousSessionId,
                status: "reset",
              } satisfies ResetResponse)
            : ({ ok: true, status: "no_active_session" } satisfies ResetResponse),
          { headers: { "cache-control": "no-store" } },
        );
      }),

      GET(EVE_SESSION_STREAM_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        return await createSessionStreamResponse(req, attachSession(sessionId));
      }),

      GET(EVE_SUBAGENT_STREAM_ROUTE_PATTERN, async (req, args) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const parentSessionId = args.params.parentSessionId;
        const callId = args.params.callId;
        const childSessionId = args.params.childSessionId;
        if (!parentSessionId || !callId || !childSessionId) {
          return Response.json(
            { error: "Missing subagent stream coordinates.", ok: false },
            { status: 400 },
          );
        }

        const startIndex = parseStartIndex(req);
        if (startIndex instanceof Response) return startIndex;
        const includeTailIndex = parseIncludeTailIndex(req);

        const childStreamPath = createEveSubagentStreamRoutePath({
          callId,
          childSessionId,
          parentSessionId,
        });
        let binding: SubagentCalledStreamEvent;
        try {
          const parent = args.attachSession(parentSessionId);
          const found = await findRemoteSubagentBinding({
            callId,
            childSessionId,
            childStreamPath,
            parentSessionId,
            parent,
          });
          if (found === undefined) {
            throw new Error("Remote subagent binding not found.");
          }
          binding = found;
        } catch {
          return Response.json({ error: "Subagent stream not found.", ok: false }, { status: 404 });
        }

        const resolveHeaders = readRemoteAgentStreamHeadersResolver(args);
        if (resolveHeaders === undefined) {
          return Response.json(
            {
              error: "Subagent stream proxy requires internal channel dispatch context.",
              ok: false,
            },
            { status: 500 },
          );
        }

        let headers: Record<string, string>;
        try {
          headers = await resolveHeaders({
            name: binding.data.toolName,
            resolverId: binding.data.remote!.resolverId,
            url: binding.data.remote!.url,
          });
        } catch {
          return Response.json({ error: "Subagent stream not found.", ok: false }, { status: 404 });
        }

        const upstreamUrl = new URL(
          createEveSessionStreamRoutePath(childSessionId).replace(/^\/+/, ""),
          `${binding.data.remote!.url.replace(/\/+$/, "")}/`,
        );
        if (startIndex !== undefined) {
          upstreamUrl.searchParams.set("startIndex", String(startIndex));
        }
        if (includeTailIndex) {
          upstreamUrl.searchParams.set("includeTailIndex", "1");
        }

        const upstream = await fetch(upstreamUrl, {
          cache: "no-store",
          headers,
          redirect: "manual",
          signal: req.signal,
        });
        const responseHeaders = new Headers();
        for (const name of [
          "cache-control",
          "content-type",
          "x-accel-buffering",
          EVE_SESSION_ID_HEADER,
          EVE_STREAM_FORMAT_HEADER,
          EVE_STREAM_TAIL_INDEX_HEADER,
          EVE_STREAM_VERSION_HEADER,
        ]) {
          const value = upstream.headers.get(name);
          if (value !== null) responseHeaders.set(name, value);
        }
        return new Response(upstream.body, {
          headers: responseHeaders,
          status: upstream.status,
          statusText: upstream.statusText,
        });
      }),
    ],
    events: input.events,
  });
}

async function findRemoteSubagentBinding(input: {
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

function normalizeEveCors(cors: EveChannelCors | undefined): ChannelCors {
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

async function resolveOnMessage(input: {
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

interface ParsedCreateBody {
  callback?: SessionCallback;
  capabilities?: SessionCapabilities;
  message: string | UserContent;
  mode?: RunMode;
  context?: readonly string[];
  operationId?: string;
  outputSchema?: JsonObject;
}

/** Replay-stable identity for one authenticated create operation. */
async function deriveOperationContinuationToken(input: {
  readonly auth: SessionAuthContext;
  readonly operationId: string;
}): Promise<string> {
  const identity = JSON.stringify([
    "eve:create-session:v1",
    input.auth.authenticator,
    input.auth.issuer ?? null,
    input.auth.principalType,
    input.auth.principalId,
    input.operationId,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `eve:op:${hex.slice(0, 32)}`;
}

function parseCreateBody(payload: Record<string, unknown>): ParsedCreateBody | Response {
  if (payload.inputResponses !== undefined) {
    return Response.json(
      { error: "'inputResponses' is only accepted for an existing session.", ok: false },
      { status: 400 },
    );
  }
  const message = parseMessageField(payload.message);
  if (message instanceof Response) return message;

  const context = parseClientContextField(payload.clientContext);
  if (context instanceof Response) return context;

  const callback = parseCallbackField(payload.callback);
  if (callback instanceof Response) return callback;

  const capabilities = parseCapabilitiesField(payload.capabilities);
  if (capabilities instanceof Response) return capabilities;

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

  const rawOperationId = payload.operationId;
  if (rawOperationId !== undefined && (typeof rawOperationId !== "string" || !rawOperationId)) {
    return Response.json(
      { error: "Expected 'operationId' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }

  const result: ParsedCreateBody = {
    callback,
    capabilities,
    message,
    mode,
    context,
    outputSchema,
  };
  if (typeof rawOperationId === "string") result.operationId = rawOperationId;
  return result;
}

interface ParsedSessionMessageBody {
  callback?: SessionCallback;
  message?: string | UserContent;
  inputResponses?: readonly ValidatedInputResponse[];
  context?: readonly string[];
  outputSchema?: JsonObject;
  turnPolicy?: TurnPolicy;
}

function parseSessionMessageBody(
  payload: Record<string, unknown>,
): ParsedSessionMessageBody | Response {
  const tokenRejection = rejectSessionContinuationToken(payload);
  if (tokenRejection !== null) return tokenRejection;

  const message = parseMessageField(payload.message);
  if (message instanceof Response) return message;
  const callback = parseCallbackField(payload.callback);
  if (callback instanceof Response) return callback;
  const inputResponses = parseInputResponses(payload.inputResponses);
  if (inputResponses instanceof Response) return inputResponses;
  const context = parseClientContextField(payload.clientContext);
  if (context instanceof Response) return context;
  const outputSchema = parseOutputSchemaField(payload.outputSchema);
  if (outputSchema instanceof Response) return outputSchema;
  const turnPolicy = parseTurnPolicyField(payload.turnPolicy);
  if (turnPolicy instanceof Response) return turnPolicy;

  if (message === undefined && inputResponses === undefined) {
    return Response.json(
      {
        error: "Expected a non-empty 'message' or a non-empty 'inputResponses' array.",
        ok: false,
      },
      { status: 400 },
    );
  }

  if (message !== undefined && inputResponses !== undefined) {
    return Response.json(
      { error: "'message' and 'inputResponses' are mutually exclusive.", ok: false },
      { status: 400 },
    );
  }

  return { callback, message, inputResponses, context, outputSchema, turnPolicy };
}

interface ParsedCancelTurnBody {
  taskId?: string;
  turnId?: string;
}

async function parseCancelTurnBody(req: Request): Promise<ParsedCancelTurnBody | Response> {
  const payload = await parseOptionalJsonRequest(req);
  if (payload instanceof Response) return payload;
  const tokenRejection = rejectSessionContinuationToken(payload);
  if (tokenRejection !== null) return tokenRejection;

  const turnId = payload.turnId;
  const taskId = payload.taskId;
  if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
    return Response.json(
      { error: "Expected 'turnId' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }
  if (taskId !== undefined && (typeof taskId !== "string" || taskId.length === 0)) {
    return Response.json(
      { error: "Expected 'taskId' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }
  const result: ParsedCancelTurnBody = {};
  if (typeof taskId === "string") result.taskId = taskId;
  if (typeof turnId === "string") result.turnId = turnId;
  return result;
}

async function parseJsonRequest(req: Request): Promise<Record<string, unknown> | Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }
  return payload as Record<string, unknown>;
}

async function parseResetBody(req: Request): Promise<{ readonly reason?: string } | Response> {
  const payload = await parseOptionalJsonRequest(req);
  if (payload instanceof Response) return payload;
  const tokenRejection = rejectSessionContinuationToken(payload);
  if (tokenRejection !== null) return tokenRejection;
  const reason = payload.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    return Response.json(
      { error: "Expected 'reason' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }
  return reason === undefined ? {} : { reason };
}

async function parseSessionControlBody(req: Request): Promise<Record<string, unknown> | Response> {
  const payload = await parseOptionalJsonRequest(req);
  if (payload instanceof Response) return payload;
  return rejectSessionContinuationToken(payload) ?? payload;
}

async function parseOptionalJsonRequest(req: Request): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return Response.json({ error: "Unreadable request body.", ok: false }, { status: 400 });
  }
  if (text.trim().length === 0) return {};

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }
  return payload as Record<string, unknown>;
}

function rejectSessionContinuationToken(payload: Record<string, unknown>): Response | null {
  return "continuationToken" in payload
    ? Response.json(
        { error: "Session-ID routes do not accept 'continuationToken'.", ok: false },
        { status: 400 },
      )
    : null;
}

function requireSessionId(params: Readonly<Record<string, string>>): string | Response {
  const sessionId = params.sessionId;
  return sessionId || Response.json({ error: "Missing session id.", ok: false }, { status: 400 });
}

async function createSessionStreamResponse(request: Request, session: Session): Promise<Response> {
  const startIndex = parseStartIndex(request);
  if (startIndex instanceof Response) return startIndex;
  const includeTailIndex = parseIncludeTailIndex(request);

  try {
    const tailIndex = includeTailIndex ? await session.getStreamTailIndex() : undefined;
    const events = await session.getEventStream({ startIndex });
    const headers = new Headers({
      "cache-control": "no-store, no-transform",
      "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE,
      "x-accel-buffering": "no",
      [EVE_SESSION_ID_HEADER]: session.id,
      [EVE_STREAM_FORMAT_HEADER]: EVE_MESSAGE_STREAM_FORMAT,
      [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
    });
    if (tailIndex !== undefined) {
      headers.set(EVE_STREAM_TAIL_INDEX_HEADER, String(tailIndex));
    }
    return new Response(
      serializeAsNdjson(events, request.signal, streamEventLimit(startIndex, tailIndex)),
      { headers },
    );
  } catch {
    return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
  }
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

function parseCapabilitiesField(value: unknown): SessionCapabilities | Response | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Response.json(
      { error: "Expected 'capabilities' to be an object.", ok: false },
      { status: 400 },
    );
  }

  const keys = Object.keys(value);
  const requestInput = Reflect.get(value, "requestInput");
  if (
    keys.some((key) => key !== "requestInput") ||
    (requestInput !== undefined && typeof requestInput !== "boolean")
  ) {
    return Response.json(
      { error: "Expected 'capabilities.requestInput' to be a boolean when provided.", ok: false },
      { status: 400 },
    );
  }

  return requestInput === undefined ? {} : { requestInput };
}

function parseModeField(value: unknown): RunMode | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "conversation" || value === "task") return value;
  return Response.json(
    { error: "Expected 'mode' to be either 'conversation' or 'task'.", ok: false },
    { status: 400 },
  );
}

function parseTurnPolicyField(value: unknown): TurnPolicy | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "queue" || value === "steer") return value;
  return Response.json(
    { error: "Expected 'turnPolicy' to be either 'queue' or 'steer'.", ok: false },
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
  body: ParsedCreateBody | ParsedSessionMessageBody,
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

function parseInputResponses(
  value: unknown,
): readonly ValidatedInputResponse[] | Response | undefined {
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

function parseIncludeTailIndex(request: Request): boolean {
  const raw = new URL(request.url).searchParams.get("includeTailIndex");
  return raw === "1" || raw === "true";
}

function parseStartIndex(request: Request): number | undefined | Response {
  const raw = new URL(request.url).searchParams.get("startIndex");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    return Response.json(
      { error: "Expected startIndex to be an integer.", ok: false },
      { status: 400 },
    );
  }
  return parsed;
}

function streamEventLimit(
  startIndex: number | undefined,
  tailIndex: number | undefined,
): number | undefined {
  if (tailIndex === undefined) return undefined;
  const resolvedStartIndex =
    startIndex === undefined
      ? 0
      : startIndex < 0
        ? Math.max(0, tailIndex + 1 + startIndex)
        : startIndex;
  return Math.max(0, tailIndex - resolvedStartIndex + 1);
}

function serializeAsNdjson(
  events: ReadableStream<unknown>,
  signal: AbortSignal,
  eventLimit?: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let eventCount = 0;
  const transform = new TransformStream<unknown, Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("\n"));
      if (eventLimit === 0) controller.terminate();
    },
    transform(event, controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      eventCount += 1;
      if (eventCount === eventLimit) controller.terminate();
    },
  });
  void events.pipeTo(transform.writable, { signal }).catch(() => {});
  return transform.readable;
}
