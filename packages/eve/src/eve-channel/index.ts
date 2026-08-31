import type { SessionAuthContext } from "#channel/types.js";
import type { Session } from "#channel/session.js";
import { resolveForwardedPrincipal } from "#channel/forwarded-principal.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import {
  handleConnectionCallbackRequest,
  handleLegacyConnectionCallbackRequest,
} from "#execution/connections/callback-route.js";
import { handleActivityRequest } from "#execution/activity-route.js";
import { handleSessionCallbackRequest } from "#execution/session-callback-route.js";
import { handleTaskInputResponseRequest } from "#execution/task-input-response-route.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  readAgentInfoRouteResponse,
  readRemoteAgentStreamHeadersResolver,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import {
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
  type SubagentCalledStreamEvent,
} from "#protocol/message.js";
import {
  EVE_ACTIVITY_ROUTE_PATTERN,
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
import type { CancelTurnResponse } from "#protocol/cancel-turn.js";
import type { ClearResponse } from "#protocol/clear-session.js";
import type { CompactResponse } from "#protocol/compact-session.js";
import type { ResetResponse } from "#protocol/reset-session.js";
import { parseTraceparent } from "#protocol/traceparent.js";
import {
  FORWARDED_AUDIENCE_SOURCE,
  FORWARDED_AUDIENCE_SOURCE_KEY,
  readForwardedAudienceBaggage,
} from "#protocol/baggage.js";
import { routeAuth } from "#public/channels/auth.js";
import { mergeUploadPolicy } from "#public/channels/upload-policy.js";
import { defineChannel, GET, HEAD, POST } from "#public/definitions/channel.js";
import {
  checkUploadPolicy,
  createSessionStreamResponse,
  deriveOperationContinuationToken,
  parseCancelTurnBody,
  parseCreateBody,
  parseIncludeTailIndex,
  parseJsonRequest,
  parseResetBody,
  parseSessionControlBody,
  parseSessionMessageBody,
  parseStartIndex,
  rejectSessionContinuationToken,
  requireSessionId,
} from "#eve-channel/request.js";
import { attachClientContext } from "#internal/client-context.js";
import {
  findRemoteSubagentBinding,
  healthResponse,
  normalizeEveCors,
  resolveOnMessage,
} from "#eve-channel/support.js";
import type { EveChannel, EveChannelInput, EveEventContext } from "#eve-channel/types.js";

export * from "#eve-channel/types.js";

const log = createLogger("eve.channel");

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
      GET(EVE_HEALTH_ROUTE_PATH, async () => healthResponse()),
      HEAD(EVE_HEALTH_ROUTE_PATH, async () => healthResponse()),

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

      GET(EVE_CONNECTION_CALLBACK_ROUTE_PATTERN, handleConnectionCallbackRequest),
      POST(EVE_CONNECTION_CALLBACK_ROUTE_PATTERN, handleConnectionCallbackRequest),
      GET(EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN, handleLegacyConnectionCallbackRequest),
      POST(EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN, handleLegacyConnectionCallbackRequest),
      POST(EVE_ACTIVITY_ROUTE_PATTERN, handleActivityRequest),
      POST(EVE_CALLBACK_ROUTE_PATTERN, handleSessionCallbackRequest),
      POST(EVE_TASK_INPUT_ROUTE_PATTERN, handleTaskInputResponseRequest),

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
        const parsedParentTraceContext =
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

        const forwardedAudienceBaggage =
          parsedParentTraceContext === undefined
            ? "absent"
            : readForwardedAudienceBaggage(req.headers.get("baggage"));
        const acceptsForwardedAudience =
          forwarded.accepted && forwardedAudienceBaggage === "public";
        if (forwardedAudienceBaggage === "malformed") {
          log.warn("ignoring malformed forwarded audience baggage", {
            forwarder: authResult.principalId,
          });
        } else if (forwardedAudienceBaggage === "public") {
          if (forwarded.accepted) {
            log.info("accepted forwarded public audience", {
              forwarder: authResult.principalId,
            });
          } else {
            log.warn("ignoring forwarded audience without an accepted principal", {
              forwarder: authResult.principalId,
            });
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
            activityObserver: body.activityObserver,
            auth: messageResult.auth,
            capabilities:
              body.capabilities ?? (body.mode === "task" ? undefined : { requestInput: true }),
            callback: body.callback,
            channelMetadata: !acceptsForwardedAudience
              ? undefined
              : {
                  kind: "eve",
                  metadata: {
                    audience: "public",
                    [FORWARDED_AUDIENCE_SOURCE_KEY]: FORWARDED_AUDIENCE_SOURCE,
                  },
                },
            continuationToken: operationToken,
            initiatorAuth: forwarded.accepted ? forwarded.initiatorAuth : undefined,
            input: attachClientContext(
              {
                message: body.message,
                context: messageResult.context,
                outputSchema: body.outputSchema,
              },
              body.context,
            ),
            mode: body.mode ?? "conversation",
            parentTraceContext: parsedParentTraceContext,
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

        let context: readonly string[] | undefined;
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
          context = messageResult.context;
          dispatchAuth = messageResult.auth;
        }

        let result: Awaited<ReturnType<Session["send"]>>;
        try {
          const session = attachSession(sessionId);
          const options = attachClientContext(
            {
              activityObserver: body.activityObserver,
              auth: dispatchAuth,
              callback: body.callback,
              context,
              outputSchema: body.outputSchema,
              turnPolicy: body.turnPolicy,
            },
            body.context,
          );
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
