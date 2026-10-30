import type { H3Event } from "nitro";
import { getRouterParams } from "nitro/h3";
import { sessionCommandErrorResponse } from "#eve-channel/support.js";
import {
  context as otelContext,
  trace as otelTrace,
  type SpanContext,
} from "#compiled/@opentelemetry/api/index.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import type { RouteHandlerArgs, WebSocketRouteHooks } from "#channel/routes.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { createAgentDescriptionRouteArgs } from "#channel/agent-description.js";
import { createChannelOperations } from "#channel/channel-operations.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { createAttachSessionFn } from "#channel/session.js";
import { createLogger, logError } from "#internal/logging.js";
import { readTrustedDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import {
  attachAgentInfoRouteResponse,
  attachHomeRouteMetadata,
  attachRouteChannelName,
  attachRemoteAgentStreamHeadersResolver,
  attachRouteSessionCreator,
  attachSkillFileSource,
} from "#internal/nitro/routes/channel-route-context.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { traceChannelRequest } from "#internal/nitro/routes/channel-request-instrumentation.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { createRouteInvokeTool } from "#internal/nitro/routes/route-invoke-tool.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { withVercelOidcProjectResolver } from "#channel/auth/vercel-oidc-project.js";
import { withLocalDevRequestScope } from "#runtime/local-dev-capability.js";
import { getWorld } from "#internal/workflow/runtime.js";

const log = createLogger("channel.dispatch");

/**
 * Dispatches one channel request identified by `routeKey`.
 *
 * Each channel route is mounted as its own virtual Nitro handler with the
 * route key and artifacts config baked in. Nitro's router matches the URL
 * and populates `event.context.params`, so no custom URL matching is
 * needed — the handler looks up the channel by its `(method, urlPath)` key
 * directly. Each task a route registers through `ctx.waitUntil` goes to
 * `event.waitUntil()` as soon as it is registered, including work started
 * while a streamed body is still being sent, so webhook acknowledgements
 * can return immediately.
 *
 * Authored channels receive `RouteHandlerArgs`; framework-internal channels
 * receive the smaller `RouteContext` used by callback routes.
 */
export async function dispatchChannelRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<Response> {
  const params = decodeRouteParams(event);
  if (params === undefined) return malformedParamsResponse();
  return await traceChannelRequest({ request: event.req, routeKey }, async (span) => {
    // Correlation does not require an eve-owned request span. Preserve any
    // active platform request or function span before route resolution.
    const requestTraceContext =
      span?.reference ?? otelTrace.getSpan(otelContext.active())?.spanContext();
    const bundle = await resolveNitroChannelRuntimeBundle(config);
    const matchedChannel = channelsByRouteKey(bundle.channels).get(routeKey);

    if (matchedChannel === undefined) {
      return Response.json(
        { error: "No matching channel for this request.", ok: false },
        { status: 404 },
      );
    }

    // Channel identity is known only after resolution; a 404 span carries
    // just the route. `span` is undefined when instrumentation opted out of
    // channel-request tracing. Prefer the stamped instrumentation kind
    // (`channel:<name>`) over the raw adapter kind — behaviorless authored
    // channels keep adapter kind `"http"`, so the adapter alone would report
    // `"http"` where the rest of the trace reports `channel:<name>`.
    span?.channel({ channelName: matchedChannel.name });
    const channelKind =
      getChannelInstrumentationKind(matchedChannel.definition) ?? matchedChannel.adapter?.kind;
    if (channelKind !== undefined) {
      span?.channel({ channelKind });
    }

    const args = await buildRouteArgs({
      bundle,
      channel: matchedChannel,
      channelKind: channelKind ?? "channel",
      config,
      event,
      params,
      requestTraceContext,
      routeKey,
    });

    try {
      return await withDevelopmentVercelOidcContext(config, event.req, async () => {
        if (matchedChannel.handler) {
          // Authored CompiledChannel route — build RouteHandlerArgs.
          return await matchedChannel.handler(event.req, args);
        }

        // Framework-internal fetch-only channel (e.g. the connection
        // callback route). Build a RouteContext with the agent handle.
        const ctx: RouteContext = {
          waitUntil: args.waitUntil,
          params: args.params,
          requestIp: args.requestIp,
        };

        return await matchedChannel.fetch(event.req, ctx);
      });
    } catch (error) {
      const commandError = sessionCommandErrorResponse(error);
      if (commandError !== undefined) return commandError;
      // Without this a handler throw is only Nitro's default 5xx, with no eve
      // log. logError records the exception against the active request span,
      // so traceChannelRequest must not record the returned 500 again.
      const errorId = logError(log, "channel handler threw", error, {
        routeKey,
        channel: matchedChannel.name,
      });
      return Response.json(
        { error: "Channel handler failed.", errorId, ok: false },
        { status: 500 },
      );
    }
  });
}

export async function dispatchChannelWebSocketRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<WebSocketRouteHooks> {
  const params = decodeRouteParams(event);
  if (params === undefined) {
    return rejectWebSocketUpgrade(MALFORMED_PARAMS_BODY, 400);
  }
  const bundle = await resolveNitroChannelRuntimeBundle(config);
  const matchedChannel = channelsByRouteKey(bundle.channels).get(routeKey);

  if (matchedChannel === undefined || matchedChannel.websocket === undefined) {
    return rejectWebSocketUpgrade(
      { error: "No matching websocket channel for this request.", ok: false },
      404,
    );
  }

  const websocket = matchedChannel.websocket;
  const channelKind =
    getChannelInstrumentationKind(matchedChannel.definition) ??
    matchedChannel.adapter?.kind ??
    "channel";
  const args = await buildRouteArgs({
    bundle,
    channel: matchedChannel,
    channelKind,
    config,
    event,
    params,
    requestTraceContext: undefined,
    routeKey,
  });

  try {
    return await withDevelopmentVercelOidcContext(
      config,
      event.req,
      async () => await websocket(event.req, args),
    );
  } catch (error) {
    const errorId = logError(log, "channel websocket handler threw", error, {
      routeKey,
      channel: matchedChannel.name,
    });
    return rejectWebSocketUpgrade(
      { error: "Channel websocket handler failed.", errorId, ok: false },
      500,
    );
  }
}

async function withDevelopmentVercelOidcContext<T>(
  config: NitroArtifactsConfig,
  request: Request,
  callback: () => Promise<T>,
): Promise<T> {
  if (config.kind !== "development") {
    return await callback();
  }

  return await withLocalDevRequestScope(
    request,
    async () =>
      await withVercelOidcProjectResolver(
        {
          request,
          resolveCurrentProject: async () => {
            const link = await readVercelProjectLink(config.appRoot);
            return link === undefined
              ? undefined
              : { environment: "development", projectId: link.projectId };
          },
        },
        callback,
      ),
  );
}

async function buildRouteArgs(input: {
  readonly bundle: Awaited<ReturnType<typeof resolveNitroChannelRuntimeBundle>>;
  readonly channel: ResolvedChannelDefinition;
  readonly channelKind: string;
  readonly config: NitroArtifactsConfig;
  readonly event: H3Event;
  readonly params: Record<string, string>;
  readonly requestTraceContext: SpanContext | undefined;
  readonly routeKey: string;
}): Promise<RouteHandlerArgs> {
  const { bundle, channel, channelKind, config, event, params, requestTraceContext } = input;
  const channelName = channel.name;
  const requestId = readVercelRequestId(event.req.headers);
  const requestIp = extractRequestIp(event, config);
  // Each task gets its own catch, so failed post-ack work (such as the Slack
  // inbound dispatch) is logged instead of dropped by the platform.
  const waitUntil = (task: Promise<unknown>) => {
    event.waitUntil(
      task.catch((error: unknown) => {
        logError(log, "channel background task failed", error, {
          routeKey: input.routeKey,
          channel: channelName,
        });
      }),
    );
  };
  const adapter = channel.adapter ?? { kind: "channel" };
  const acceptedDeploymentId = await resolveAcceptedDeploymentId(config);
  const deliverySource = {
    acceptedDeploymentId,
    channelKind,
    channelName,
    requestId,
    requestTraceContext:
      requestTraceContext === undefined
        ? undefined
        : {
            spanId: requestTraceContext.spanId,
            traceFlags: requestTraceContext.traceFlags,
            traceId: requestTraceContext.traceId,
          },
  };
  const channelOperations = createChannelOperations({
    adapter,
    channelName,
    metadata: deliverySource,
    runtime: bundle.runtime,
    turnPolicy: channel.turnPolicy,
  });
  const attachSession = createAttachSessionFn(bundle.runtime, {
    ...deliverySource,
    turnPolicy: channel.turnPolicy,
  });
  const to = createCrossChannelToFn(
    bundle.runtime,
    toCrossChannelTargets(bundle.channels),
    deliverySource,
  );

  const agent = createAgentDescriptionRouteArgs(() => resolveNitroCompiledArtifactsSource(config));
  const args = attachRouteSessionCreator(
    attachHomeRouteMetadata(
      attachRouteChannelName(
        attachAgentInfoRouteResponse(
          {
            attachSession,
            ...channelOperations,
            ...agent.args,
            invokeTool: createRouteInvokeTool({
              agentName: bundle.agentName,
              config,
              origin: { adapter, agentName: bundle.agentName, channelName },
              requestUrl: event.req.url,
            }),
            params,
            requestIp,
            to,
            waitUntil,
          },
          async () => {
            const { handleAgentInfoRequest } = await import("#internal/nitro/routes/info.js");
            return await handleAgentInfoRequest(config);
          },
        ),
        channelName,
      ),
      { agentName: bundle.agentName },
    ),
    async (input) => {
      const { deliveryId, ...runInput } = input;
      const generated = createChannelDeliveryMetadata(deliverySource);
      const delivery = deliveryId === undefined ? generated : { ...generated, deliveryId };
      const handle = await bundle.runtime.createSession({
        ...runInput,
        adapter,
        channelName,
        continuationToken:
          input.continuationToken === undefined
            ? undefined
            : `${channelName}:${input.continuationToken}`,
        delivery,
        requestId,
      });
      return { ...handle, deliveryId: delivery.deliveryId };
    },
  );
  attachSkillFileSource(args, agent.skillFiles);
  if (bundle.resolveRemoteAgentStreamHeaders !== undefined) {
    attachRemoteAgentStreamHeadersResolver(args, bundle.resolveRemoteAgentStreamHeaders);
  }

  return args;
}

async function resolveAcceptedDeploymentId(
  config: NitroArtifactsConfig,
): Promise<string | undefined> {
  const hosted = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  if (hosted !== undefined && hosted.length > 0) return validateDeploymentId(hosted);

  // Scenario and inspection callers can invoke a development route directly,
  // outside the dev worker whose transport secret proves that its World is
  // installed. Those read-only calls keep the pre-existing unstamped shape.
  if (config.kind === "development" && process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] === undefined) {
    return undefined;
  }
  return validateDeploymentId(await (await getWorld()).getDeploymentId());
}

function validateDeploymentId(deploymentId: string): string {
  if (deploymentId.length === 0 || deploymentId === "latest") {
    throw new Error("Channel ingress could not resolve an exact deployment id.");
  }
  return deploymentId;
}

function readVercelRequestId(headers: Headers): string | undefined {
  const requestId = headers.get("x-vercel-id")?.trim();
  return requestId === "" ? undefined : requestId;
}

function rejectWebSocketUpgrade(
  body: Record<string, unknown>,
  status: number,
): WebSocketRouteHooks {
  return {
    upgrade() {
      throw Response.json(body, { status });
    },
  };
}

const MALFORMED_PARAMS_BODY = {
  error: "The request path has malformed percent-encoding.",
  ok: false,
} as const;

function malformedParamsResponse(): Response {
  return Response.json(MALFORMED_PARAMS_BODY, { status: 400 });
}

/**
 * The matched route's params, percent-decoded except for encoded `/` and
 * `\`, which stay encoded so a param never gains a path separator. A path
 * with malformed percent-encoding has no params.
 */
function decodeRouteParams(event: H3Event): Record<string, string> | undefined {
  try {
    return getRouterParams(event, { decode: true });
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

const routeKeyIndexes = new WeakMap<
  readonly ResolvedChannelDefinition[],
  ReadonlyMap<string, ResolvedChannelDefinition>
>();

/** The channels of one resolved bundle by route key, built once per bundle. */
function channelsByRouteKey(
  channels: readonly ResolvedChannelDefinition[],
): ReadonlyMap<string, ResolvedChannelDefinition> {
  let index = routeKeyIndexes.get(channels);
  if (index === undefined) {
    const byRouteKey = new Map<string, ResolvedChannelDefinition>();
    for (const channel of channels) {
      const routeKey = `${channel.method.toUpperCase()} ${channel.urlPath}`;
      if (!byRouteKey.has(routeKey)) byRouteKey.set(routeKey, channel);
    }
    index = byRouteKey;
    routeKeyIndexes.set(channels, index);
  }
  return index;
}

function extractRequestIp(event: H3Event, config: NitroArtifactsConfig): string | null {
  if (config.kind === "development") {
    // In the proxied dev topology the socket peer is the parent's loopback
    // hop; the original client address arrives as parent-signed metadata.
    const trusted = readTrustedDevelopmentClientAddress(
      event.req.headers,
      process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV],
    );
    if (trusted !== undefined) {
      return trusted;
    }
  }
  return extractSocketIp(event);
}

function extractSocketIp(event: H3Event): string | null {
  const ip = event.req.ip;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}
