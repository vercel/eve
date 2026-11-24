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
import { createChannelRouteArgs } from "#channel/route-args.js";
import { createLogger, logError } from "#internal/logging.js";
import { readTrustedDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/application/dev-transport.js";
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

export async function dispatchChannelRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<Response> {
  const params = getRouterParams(event, { decode: true });
  return await traceChannelRequest({ request: event.req, routeKey }, async (span) => {
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
          return await matchedChannel.handler(event.req, args);
        }

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
  const params = getRouterParams(event, { decode: true });
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
  const waitUntil = (task: Promise<unknown>) => {
    event.waitUntil(
      Promise.resolve(task).catch((error: unknown) => {
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
  const to = createCrossChannelToFn(
    bundle.runtime,
    toCrossChannelTargets(bundle.channels),
    deliverySource,
  );

  const agent = createAgentDescriptionRouteArgs(() => resolveNitroCompiledArtifactsSource(config));
  return createChannelRouteArgs({
    adapter,
    compiledArtifactsSource: () => resolveNitroCompiledArtifactsSource(config),
    agent: {
      ...agent.args,
      invokeTool: createRouteInvokeTool({
        agentName: bundle.agentName,
        config,
        origin: { adapter, agentName: bundle.agentName, channelName },
        requestUrl: event.req.url,
      }),
    },
    agentInfo: async () => {
      const { handleAgentInfoRequest } = await import("#internal/nitro/routes/info.js");
      return await handleAgentInfoRequest(config);
    },
    agentName: bundle.agentName,
    deliverySource,
    params,
    remoteAgentStreamHeaders: bundle.resolveRemoteAgentStreamHeaders,
    requestIp,
    runtime: bundle.runtime,
    skillFiles: agent.skillFiles,
    subscriptionEvents: channel.definition?.events,
    to,
    turnPolicy: channel.turnPolicy,
    waitUntil,
  });
}

async function resolveAcceptedDeploymentId(
  config: NitroArtifactsConfig,
): Promise<string | undefined> {
  const hosted = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  if (hosted !== undefined && hosted.length > 0) return validateDeploymentId(hosted);

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

const routeKeyIndexes = new WeakMap<
  readonly ResolvedChannelDefinition[],
  ReadonlyMap<string, ResolvedChannelDefinition>
>();

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
