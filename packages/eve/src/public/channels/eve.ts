import { type FilePart, type TextPart, type UserContent } from "ai";

import type {
  CancelTurnResult,
  SessionAuthContext,
  SessionCallback,
  SessionCapabilities,
} from "#channel/types.js";
import type { CancelTurnResponse } from "#protocol/cancel-turn.js";
import type { ClearResponse } from "#protocol/clear-session.js";
import type { CompactResponse } from "#protocol/compact-session.js";
import type { ResetResponse } from "#protocol/reset-session.js";
import type { SendOptions } from "#channel/routes.js";
import type { FixedSession } from "#channel/session.js";
import { resolveForwardedPrincipal, type TrustedForwarders } from "#channel/forwarded-principal.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  readAgentInfoRouteResponse,
  readRouteAgent,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { AgentHandleError } from "#protocol/agent-handle-error.js";
import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_MESSAGE_STREAM_FORMAT,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import {
  EVE_CANCEL_TURN_ROUTE_PATTERN,
  EVE_CLEAR_SESSION_ROUTE_PATH,
  EVE_COMPACT_SESSION_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
  EVE_RESET_SESSION_ROUTE_PATH,
  EVE_SESSIONS_ROUTE_PATH,
  EVE_SESSION_CANCEL_ROUTE_PATTERN,
  EVE_SESSION_CLEAR_ROUTE_PATTERN,
  EVE_SESSION_COMPACT_ROUTE_PATTERN,
  EVE_SESSION_MESSAGES_ROUTE_PATTERN,
  EVE_SESSION_RESET_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";
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
  type ChannelCors,
  type ChannelEvents,
  type ChannelSessionOps,
} from "#public/definitions/channel.js";
import type { ChannelMethod } from "#public/definitions/channel.js";
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
   * The trusted-forwarders policy: which transport-authenticated callers may
   * assert a forwarded principal on the create-session route (the
   * `forwardedPrincipal` body field a `defineRemoteAgent({ forwardPrincipal:
   * true })` sender emits). The predicate receives the *verified* route-auth
   * principal of the forwarder — who is asserting, never what is asserted —
   * and must match it precisely (for example
   * `(forwarder) => forwarder.subject === vercelSubject({ teamSlug, projectName })`).
   * A permissive predicate lets any authenticated forwarder assert any
   * principal.
   *
   * When a trusted forwarder's assertion is accepted, the forwarded
   * principal replaces the session principal (`session.auth.current` /
   * `session.auth.initiator`) exactly as if that user had called this
   * deployment directly, and the forwarder is recorded on the accepted
   * contexts as the `eve:forwarded-by` attribute. Omit the option to reject
   * every forwarded assertion with 403.
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
 * built-in `/eve/v1` routes (GET inspects the agent, POST creates a session, POST
 * delivers a follow-up, POST cancels an active turn or retires a session, GET
 * streams a session's NDJSON event feed). Every route
 * runs {@link EveChannelInput.auth} via {@link routeAuth} before dispatching.
 * Default-export the result as your `agent/channels/eve.ts` channel; reach for
 * {@link defineChannel} directly only for a custom transport.
 */
export function eveChannel(input: EveChannelInput): EveChannel {
  const uploadPolicy = mergeUploadPolicy(input.uploadPolicy);

  return defineChannel<undefined, EveEventContext>({
    cors: normalizeEveCors(input.cors),
    routes: [
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

      POST(EVE_SESSIONS_ROUTE_PATH, async (req, args) => {
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

        const policyRejection = checkUploadPolicy(body, uploadPolicy);
        if (policyRejection !== null) return policyRejection;

        const messageResult = await resolveOnMessage({
          auth: forwarded.auth,
          config: input,
          message: body.message,
          request: req,
        });
        if (messageResult instanceof Response) return messageResult;
        if (!messageResult.dispatch) return droppedMessageResponse();

        const createSession = readRouteSessionCreator(args);
        if (createSession === undefined) {
          return Response.json(
            { error: "Session creation requires internal channel dispatch context.", ok: false },
            { status: 500 },
          );
        }

        const handle = await createSession({
          auth: messageResult.auth,
          capabilities: body.mode === "task" ? undefined : { requestInput: true },
          callback: body.callback,
          initiatorAuth: forwarded.accepted ? forwarded.initiatorAuth : undefined,
          input: {
            message: body.message,
            context: mergeContext(body.context, messageResult.context),
            outputSchema: body.outputSchema,
          },
          mode: body.mode ?? "conversation",
        });

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

      POST(EVE_SESSION_MESSAGES_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        const payload = await parseJsonRequest(req);
        if (payload instanceof Response) return payload;
        const body = parseSessionMessageBody(payload);
        if (body instanceof Response) return body;

        const policyRejection = checkUploadPolicy(body, uploadPolicy);
        if (policyRejection !== null) return policyRejection;

        let context = body.context;
        let dispatchAuth: SessionAuthContext | null = authResult;
        if (body.message !== undefined) {
          const messageResult = await resolveOnMessage({
            auth: authResult,
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

        const result = await attachSession(sessionId).send({
          auth: dispatchAuth,
          context,
          inputResponses: body.inputResponses,
          message: body.message,
          outputSchema: body.outputSchema,
        });
        if (result.status === "session_not_active") {
          return Response.json(
            { code: "session_not_active", ok: false },
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
        const body = await parseCancelTurnBody(req, { rejectContinuationToken: true });
        if (body instanceof Response) return body;
        const result = await attachSession(sessionId).cancel({ turnId: body.turnId });
        return Response.json(
          { ok: true, sessionId, status: result.status } satisfies CancelTurnResponse,
          { headers: { "cache-control": "no-store" } },
        );
      }),

      POST(EVE_SESSION_COMPACT_ROUTE_PATTERN, async (req, { attachSession, params }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;
        const sessionId = requireSessionId(params);
        if (sessionId instanceof Response) return sessionId;
        const body = await parseSessionControlBody(req);
        if (body instanceof Response) return body;
        const result = await attachSession(sessionId).compact();
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
        const result = await attachSession(sessionId).clear();
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
        const result = await attachSession(sessionId).reset({ reason: body.reason });
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

        const forwarded = await resolveForwardedPrincipal({
          trustedForwarders: input.trustedForwarders,
          forwarder: sessionAuth,
          payload: payload as Record<string, unknown>,
        });
        if (forwarded instanceof Response) return forwarded;

        const body = parseCreateBody(payload as Record<string, unknown>);
        if (body instanceof Response) return body;

        const policyRejection = checkUploadPolicy(body, uploadPolicy);
        if (policyRejection !== null) return policyRejection;

        const messageResult = await resolveOnMessage({
          auth: forwarded.auth,
          config: input,
          message: body.message,
          request: req,
        });
        if (messageResult instanceof Response) return messageResult;
        if (!messageResult.dispatch) return droppedMessageResponse();

        const token = `eve:${crypto.randomUUID()}`;
        const context = mergeContext(body.context, messageResult.context);

        const sendOptions: SendOptions = {
          auth: messageResult.auth,
          callback: body.callback,
          capabilities: body.capabilities,
          continuationToken: token,
          mode: body.mode,
        };
        if (forwarded.accepted) {
          sendOptions.initiatorAuth = forwarded.initiatorAuth;
        }
        const session = await send(createSendPayload(body, context), sendOptions);

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

      POST(EVE_RESET_SESSION_ROUTE_PATH, async (req, { reset }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const body = await parseContinuationTokenBody(req);
        if (body instanceof Response) return body;

        let result: Awaited<ReturnType<typeof reset>>;
        try {
          result = await reset({
            continuationToken: body.continuationToken,
            reason: "Client requested session reset",
          });
        } catch (error) {
          const errorId = logError(log, "session-reset request failed", error);
          return Response.json(
            { error: "Failed to reset the session.", errorId, ok: false },
            { status: 500 },
          );
        }

        const response: ResetResponse =
          result.status === "reset"
            ? { ok: true, previousSessionId: result.previousSessionId, status: "reset" }
            : { ok: true, status: "no_active_session" };
        return Response.json(response, {
          headers: { "cache-control": "no-store" },
        });
      }),

      POST(EVE_CLEAR_SESSION_ROUTE_PATH, async (req, { clear }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const body = await parseContinuationTokenBody(req);
        if (body instanceof Response) return body;

        let result: Awaited<ReturnType<typeof clear>>;
        try {
          result = await clear({ continuationToken: body.continuationToken });
        } catch (error) {
          const errorId = logError(log, "session-clear request failed", error);
          return Response.json(
            { error: "Failed to clear the session context.", errorId, ok: false },
            { status: 500 },
          );
        }

        const response: ClearResponse =
          result.status === "accepted"
            ? { ok: true, sessionId: result.sessionId, status: "accepted" }
            : { ok: true, status: "no_active_session" };
        return Response.json(response, {
          headers: { "cache-control": "no-store" },
          status: result.status === "accepted" ? 202 : 200,
        });
      }),

      POST(EVE_COMPACT_SESSION_ROUTE_PATH, async (req, { compact }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const body = await parseContinuationTokenBody(req);
        if (body instanceof Response) return body;

        let result: Awaited<ReturnType<typeof compact>>;
        try {
          result = await compact({ continuationToken: body.continuationToken });
        } catch (error) {
          const errorId = logError(log, "session-compaction request failed", error);
          return Response.json(
            { error: "Failed to compact the session.", errorId, ok: false },
            { status: 500 },
          );
        }

        const response: CompactResponse =
          result.status === "accepted"
            ? { ok: true, sessionId: result.sessionId, status: "accepted" }
            : { ok: true, status: "no_active_session" };
        return Response.json(response, {
          headers: { "cache-control": "no-store" },
          status: result.status === "accepted" ? 202 : 200,
        });
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

        const sendOptions: SendOptions = {
          auth: dispatchAuth,
          continuationToken: body.continuationToken,
          // This route addresses the session in the URL. If its continuation
          // token no longer resolves, starting a new session would silently
          // change that identity, so surface SESSION_NOT_RESUMABLE instead.
          intent: "resume",
        };
        if (body.callback !== undefined) {
          sendOptions.caller = {
            callId: body.callback.callId,
            replyTo: { kind: "callback", url: body.callback.url },
            subagentName: body.callback.subagentName,
          };
        }

        let session;
        try {
          session = await send(
            {
              inputResponses: body.inputResponses,
              message: body.message,
              context,
              outputSchema: body.outputSchema,
            },
            sendOptions,
          );
        } catch (error) {
          if (!isRuntimeNoActiveSessionError(error)) {
            throw error;
          }
          return Response.json(AgentHandleError.SessionNotResumable.toJson(), { status: 404 });
        }

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

      POST(EVE_CANCEL_TURN_ROUTE_PATTERN, async (req, args) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const sessionId = args.params.sessionId;
        if (!sessionId) {
          return Response.json({ error: "Missing session id.", ok: false }, { status: 400 });
        }

        const body = await parseCancelTurnBody(req);
        if (body instanceof Response) return body;

        let result: CancelTurnResult;
        try {
          const agent = readRouteAgent(args);
          if (agent === undefined) {
            throw new Error("Missing route agent.");
          }
          result = await agent.cancelTurn({ sessionId, turnId: body.turnId });
        } catch (error) {
          const errorId = logError(log, "cancel-turn request failed", error, { sessionId });
          return Response.json(
            { error: "Failed to cancel the turn.", errorId, ok: false },
            { status: 500 },
          );
        }

        return Response.json(
          { ok: true, sessionId, status: result.status } satisfies CancelTurnResponse,
          {
            headers: {
              "cache-control": "no-store",
              [EVE_SESSION_ID_HEADER]: sessionId,
            },
            status: 202,
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

        const includeTailIndex = parseIncludeTailIndex(req);

        try {
          const session = getSession(sessionId);

          // The tail lookup is opt-in: only requests that bound a read pay for it.
          const tailIndex = includeTailIndex ? await session.getStreamTailIndex() : undefined;
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
              ...(tailIndex === undefined
                ? {}
                : { [EVE_STREAM_TAIL_INDEX_HEADER]: String(tailIndex) }),
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
  capabilities?: SessionCapabilities;
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

  return { callback, capabilities, message, mode, context, outputSchema };
}

interface ParsedContinueBody {
  callback?: SessionCallback;
  message?: string | UserContent;
  continuationToken: string;
  inputResponses?: readonly InputResponse[];
  context?: readonly string[];
  outputSchema?: JsonObject;
}

interface ParsedSessionMessageBody {
  message?: string | UserContent;
  inputResponses?: readonly InputResponse[];
  context?: readonly string[];
  outputSchema?: JsonObject;
}

function parseSessionMessageBody(
  payload: Record<string, unknown>,
): ParsedSessionMessageBody | Response {
  const tokenRejection = rejectSessionContinuationToken(payload);
  if (tokenRejection !== null) return tokenRejection;
  if (payload.forwardedPrincipal !== undefined) {
    return Response.json(
      { error: "A forwarded principal is only accepted on session creation.", ok: false },
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

  return { message, inputResponses, context, outputSchema };
}

function parseContinueBody(payload: Record<string, unknown>): ParsedContinueBody | Response {
  // Fail loud instead of silently running the delivery as the transport
  // principal: principal forwarding is create-only today.
  if (payload.forwardedPrincipal !== undefined) {
    return Response.json(
      { error: "A forwarded principal is only accepted on session creation.", ok: false },
      { status: 400 },
    );
  }

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

  const callback = parseCallbackField(payload.callback);
  if (callback instanceof Response) return callback;

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

  return { callback, message, continuationToken, inputResponses, context, outputSchema };
}

interface ParsedCancelTurnBody {
  turnId?: string;
}

interface ParsedContinuationTokenBody {
  readonly continuationToken: string;
}

async function parseContinuationTokenBody(
  req: Request,
): Promise<ParsedContinuationTokenBody | Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const continuationToken = (payload as { continuationToken?: unknown }).continuationToken;
  if (typeof continuationToken !== "string" || continuationToken.length === 0) {
    return Response.json(
      { error: "Expected 'continuationToken' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }

  return { continuationToken };
}

async function parseCancelTurnBody(
  req: Request,
  options: { readonly rejectContinuationToken?: boolean } = {},
): Promise<ParsedCancelTurnBody | Response> {
  const payload = await parseOptionalJsonRequest(req);
  if (payload instanceof Response) return payload;
  if (options.rejectContinuationToken) {
    const tokenRejection = rejectSessionContinuationToken(payload);
    if (tokenRejection !== null) return tokenRejection;
  }

  const turnId = payload.turnId;
  if (turnId === undefined) {
    return {};
  }
  if (typeof turnId !== "string" || turnId.length === 0) {
    return Response.json(
      { error: "Expected 'turnId' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }
  return { turnId };
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

async function createSessionStreamResponse(
  request: Request,
  session: FixedSession,
): Promise<Response> {
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
    return new Response(serializeAsNdjson(events), {
      headers,
    });
  } catch {
    return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
  }
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
  body: ParsedCreateBody | ParsedContinueBody | ParsedSessionMessageBody,
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

function serializeAsNdjson(events: ReadableStream<unknown>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return events.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("\n"));
      },
      transform(event, controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      },
    }),
  );
}
