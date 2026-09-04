import type { RunInput, SessionAuthContext, SessionTraceContext } from "#channel/types.js";
import type { Session } from "#channel/session.js";
import {
  authorizeTrustedForwarder,
  resolveForwardedPrincipal,
} from "#channel/forwarded-principal.js";
import {
  handleConnectionCallbackRequest,
  handleLegacyConnectionCallbackRequest,
} from "#execution/connections/callback-route.js";
import { handleActivityRequest } from "#execution/activity-route.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";
import { handleTaskInputResponseRequest } from "#execution/task-input-response-route.js";
import {
  handleWorkflowWebhookRequest,
  WORKFLOW_WEBHOOK_ROUTE_PATTERN,
} from "#execution/workflow-webhook-route.js";
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
import { readForwardedAudienceBaggage } from "#protocol/baggage.js";
import {
  traceCoordinatesEqual,
  type AgentInvocationTrace,
  type TraceCoordinates,
  validateAgentInvocationBinding,
} from "#protocol/agent-invocation-trace.js";
import {
  FAIL_CLOSED_FORWARDED_TRACE_ASSERTION,
  formatTraceContentCeiling,
} from "#shared/forwarded-trace-policy.js";
import { routeAuth } from "#public/channels/auth.js";
import { mergeUploadPolicy } from "#public/channels/upload-policy.js";
import { defineChannel, DELETE, GET, HEAD, PATCH, POST, PUT } from "#public/definitions/channel.js";
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

function acceptedSessionResponse(sessionId: string, traceContext?: TraceCoordinates): Response {
  const body: {
    ok: true;
    sessionId: string;
    status: "accepted";
    trace?: TraceCoordinates;
  } = { ok: true, sessionId, status: "accepted" };
  if (traceContext !== undefined) body.trace = traceContext;
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      [EVE_SESSION_ID_HEADER]: sessionId,
    },
    status: 202,
  });
}

function resolveCreateParentTraceContext(input: {
  readonly legacy?: SessionTraceContext;
  readonly trace?: AgentInvocationTrace;
}): SessionTraceContext | undefined {
  if (input.trace === undefined) return input.legacy;
  if (input.trace.parent === undefined) return undefined;
  return { ...input.trace.parent, isRemote: true };
}

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
      GET(WORKFLOW_WEBHOOK_ROUTE_PATTERN, handleWorkflowWebhookRequest),
      POST(WORKFLOW_WEBHOOK_ROUTE_PATTERN, handleWorkflowWebhookRequest),
      PUT(WORKFLOW_WEBHOOK_ROUTE_PATTERN, handleWorkflowWebhookRequest),
      PATCH(WORKFLOW_WEBHOOK_ROUTE_PATTERN, handleWorkflowWebhookRequest),
      DELETE(WORKFLOW_WEBHOOK_ROUTE_PATTERN, handleWorkflowWebhookRequest),

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
        // Legacy callback senders may still continue a trace via traceparent.
        // This never establishes framework parent lineage or relaxes root-session limits.
        const legacyParentTraceContext =
          body.callback === undefined
            ? undefined
            : parseTraceparent(req.headers.get("traceparent"));
        const invocationBindingError = validateAgentInvocationBinding({
          callbackCallId: body.callback?.callId,
          invocation: body.invocation,
          trace: body.trace,
          traceparent: legacyParentTraceContext,
        });
        if (invocationBindingError === "call-id-mismatch") {
          return Response.json(
            { error: "Invocation callId does not match callback callId.", ok: false },
            { status: 400 },
          );
        }
        if (invocationBindingError === "trace-context-mismatch") {
          return Response.json(
            { error: "Invocation trace context does not match traceparent.", ok: false },
            { status: 400 },
          );
        }
        if (!forwarded.accepted && (body.invocation !== undefined || body.trace !== undefined)) {
          const authorized = await authorizeTrustedForwarder({
            assertion: "agent-invocation",
            forwarder: authResult,
            trustedForwarders: input.trustedForwarders,
          });
          if (authorized instanceof Response) return authorized;
        }
        const parsedParentTraceContext = resolveCreateParentTraceContext({
          legacy: legacyParentTraceContext,
          trace: body.trace,
        });

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
            const acceptedTraceCoordinates = owner.trace;
            const replayedTraceCoordinates =
              body.trace !== undefined &&
              acceptedTraceCoordinates !== undefined &&
              traceCoordinatesEqual(body.trace.seed, acceptedTraceCoordinates)
                ? acceptedTraceCoordinates
                : undefined;
            return acceptedSessionResponse(owner.id, replayedTraceCoordinates);
          }
        }

        const forwardedTraceAssertion =
          parsedParentTraceContext === undefined
            ? "absent"
            : readForwardedAudienceBaggage(req.headers.get("baggage"));
        const acceptsLegacyPolicy =
          forwarded.accepted &&
          parsedParentTraceContext !== undefined &&
          (parsedParentTraceContext.traceFlags & 1) === 1;
        const acceptedForwardedTracePolicy =
          forwarded.accepted && body.trace?.forwardedTracePolicy !== undefined
            ? body.trace.forwardedTracePolicy
            : !acceptsLegacyPolicy
              ? undefined
              : typeof forwardedTraceAssertion === "object"
                ? forwardedTraceAssertion
                : forwardedTraceAssertion === "malformed"
                  ? FAIL_CLOSED_FORWARDED_TRACE_ASSERTION
                  : undefined;
        const parentTraceContext =
          acceptedForwardedTracePolicy === undefined || parsedParentTraceContext === undefined
            ? parsedParentTraceContext
            : {
                ...parsedParentTraceContext,
                forwardedTracePolicy: acceptedForwardedTracePolicy,
              };
        if (forwardedTraceAssertion === "malformed") {
          log.warn("using metadata-only policy for malformed forwarded audience baggage", {
            forwarder: authResult.principalId,
          });
        } else if (typeof forwardedTraceAssertion === "object") {
          if (acceptedForwardedTracePolicy !== undefined) {
            log.info("accepted forwarded trace policy", {
              audience: forwardedTraceAssertion.originAudience,
              ceiling: formatTraceContentCeiling(forwardedTraceAssertion.ceiling),
              forwarder: authResult.principalId,
            });
          } else {
            log.warn(
              "ignoring legacy forwarded trace policy without an accepted sampled principal",
              {
                forwarder: authResult.principalId,
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
          const createInput: {
            -readonly [K in keyof Omit<RunInput, "adapter" | "channelName" | "requestId">]: Omit<
              RunInput,
              "adapter" | "channelName" | "requestId"
            >[K];
          } = {
            activityObserver: body.activityObserver,
            auth: messageResult.auth,
            capabilities:
              body.capabilities ?? (body.mode === "task" ? undefined : { requestInput: true }),
            callback: body.callback,
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
            parent: body.invocation,
            parentTraceContext,
            title: messageResult.title,
          };
          if (body.trace !== undefined) {
            createInput.acceptedTraceCoordinates = body.trace.seed;
            createInput.traceSeed =
              acceptedForwardedTracePolicy === undefined
                ? body.trace.seed
                : {
                    ...body.trace.seed,
                    forwardedTracePolicy: acceptedForwardedTracePolicy,
                  };
          }
          handle = await createSession(createInput);
        } catch (error) {
          const errorId = logError(log, "session-create request failed", error);
          return Response.json(
            { error: "Failed to create the session.", errorId, ok: false },
            { status: 500 },
          );
        }

        return acceptedSessionResponse(handle.sessionId, handle.trace);
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
            tasks: body.tasks,
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
