import type { H3Event } from "nitro";
import type { RouteContext } from "#public/definitions/channel.js";
import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import type { RouteHandlerArgs, WebSocketRouteHooks } from "#channel/routes.js";
import { createChannelOperations } from "#channel/channel-operations.js";
import { createAttachSessionFn } from "#channel/session.js";
import { createLogger, logError } from "#internal/logging.js";
import { readTrustedDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { traceChannelRequest } from "#internal/nitro/routes/channel-request-instrumentation.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { withVercelOidcProjectResolver } from "#runtime/governance/auth/vercel-oidc-project.js";

const log = createLogger("channel.dispatch");

interface BuiltRouteArgs {
  readonly args: RouteHandlerArgs;
  readonly backgroundTasks: Promise<unknown>[];
}

/**
 * Dispatches one channel request identified by `routeKey`.
 *
 * Each channel route is mounted as its own virtual Nitro handler with the
 * route key and artifacts config baked in. Nitro's router matches the URL
 * and populates `event.context.params`, so no custom URL matching is
 * needed — the handler looks up the channel by its `(method, urlPath)` key
 * directly. When routes register background work through `ctx.waitUntil`,
 * Nitro forwards that work to `event.waitUntil()` so webhook
 * acknowledgements can return immediately.
 *
 * Authored channels receive `RouteHandlerArgs`; framework-internal channels
 * receive the smaller `RouteContext` used by callback routes.
 */
export async function dispatchChannelRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<Response> {
  return await traceChannelRequest({ request: event.req, routeKey }, async (span) => {
    const bundle = await resolveNitroChannelRuntimeBundle(config);

    const matchedChannel = bundle.channels.find(
      (channel) => `${channel.method.toUpperCase()} ${channel.urlPath}` === routeKey,
    );

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
    span?.setAttribute("eve.channel.name", matchedChannel.name);
    const channelKind =
      getChannelInstrumentationKind(matchedChannel.definition) ?? matchedChannel.adapter?.kind;
    if (channelKind !== undefined) {
      span?.setAttribute("eve.channel.kind", channelKind);
    }

    const routeArgs = buildRouteArgs(event, bundle, matchedChannel.name, config);

    let response: Response;

    try {
      response = await withDevelopmentVercelOidcContext(config, event.req, async () => {
        if (matchedChannel.handler) {
          // Authored CompiledChannel route — build RouteHandlerArgs.
          return await matchedChannel.handler(event.req, routeArgs.args);
        }

        // Framework-internal fetch-only channel (e.g. the connection
        // callback route). Build a RouteContext with the agent handle.
        const ctx: RouteContext = {
          waitUntil: routeArgs.args.waitUntil,
          params: routeArgs.args.params,
          requestIp: routeArgs.args.requestIp,
        };

        return await matchedChannel.fetch(event.req, ctx);
      });
    } catch (error) {
      // Without this a handler throw is only Nitro's default 5xx, with no eve
      // log. logError records the exception against the active request span,
      // so traceChannelRequest must not record the returned 500 again.
      const errorId = logError(log, "channel handler threw", error, {
        routeKey,
        channel: matchedChannel.name,
      });
      flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);
      return Response.json(
        { error: "Channel handler failed.", errorId, ok: false },
        { status: 500 },
      );
    }

    flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);

    return response;
  });
}

export async function dispatchChannelWebSocketRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<WebSocketRouteHooks> {
  const bundle = await resolveNitroChannelRuntimeBundle(config);

  const matchedChannel = bundle.channels.find(
    (channel) => `${channel.method.toUpperCase()} ${channel.urlPath}` === routeKey,
  );

  if (matchedChannel === undefined || matchedChannel.websocket === undefined) {
    return rejectWebSocketUpgrade(
      { error: "No matching websocket channel for this request.", ok: false },
      404,
    );
  }

  const websocket = matchedChannel.websocket;
  const routeArgs = buildRouteArgs(event, bundle, matchedChannel.name, config);

  try {
    const hooks = await withDevelopmentVercelOidcContext(
      config,
      event.req,
      async () => await websocket(event.req, routeArgs.args),
    );
    flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);
    return hooks;
  } catch (error) {
    const errorId = logError(log, "channel websocket handler threw", error, {
      routeKey,
      channel: matchedChannel.name,
    });
    flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);
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

  return await withVercelOidcProjectResolver(
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
  );
}

function buildRouteArgs(
  event: H3Event,
  bundle: Awaited<ReturnType<typeof resolveNitroChannelRuntimeBundle>>,
  channelName: string,
  config: NitroArtifactsConfig,
): BuiltRouteArgs {
  const requestId = readVercelRequestId(event.req.headers);
  const requestIp = extractRequestIp(event, config);
  const backgroundTasks: Promise<unknown>[] = [];
  const rawParams = (event.context.params as Record<string, string>) ?? {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    params[key] = decodeURIComponent(value);
  }

  const waitUntil = (task: Promise<unknown>) => {
    backgroundTasks.push(task);
  };
  const channel = bundle.channels.find((candidate) => candidate.name === channelName);
  const adapter = channel?.adapter ?? { kind: "channel" };
  const channelOperations = createChannelOperations({
    adapter,
    channelName,
    metadata: { requestId },
    runtime: bundle.runtime,
    turnPolicy: channel?.turnPolicy,
  });
  const attachSession = createAttachSessionFn(bundle.runtime, {
    requestId,
    turnPolicy: channel?.turnPolicy,
  });
  const to = createCrossChannelToFn(bundle.runtime, toCrossChannelTargets(bundle.channels));

  const args = attachRouteSessionCreator(
    attachAgentInfoRouteResponse(
      {
        attachSession,
        ...channelOperations,
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
    async (input) =>
      await bundle.runtime.createSession({
        ...input,
        adapter,
        channelName,
        requestId,
      }),
  );

  return {
    args,
    backgroundTasks,
  };
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

/**
 * Drains channel background tasks through `event.waitUntil`, logging each
 * rejection. A bare `waitUntil(allSettled(tasks))` never rejects and so
 * silently discards failed post-ack work (the Slack inbound dispatch).
 */
function flushBackgroundTasks(
  event: H3Event,
  tasks: Promise<unknown>[],
  routeKey: string,
  channel: string,
): void {
  if (tasks.length === 0) {
    return;
  }
  event.waitUntil(
    Promise.allSettled(tasks).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          logError(log, "channel background task failed", result.reason, {
            routeKey,
            channel,
          });
        }
      }
    }),
  );
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
