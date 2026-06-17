import type { H3Event } from "nitro";
import type { RouteContext } from "#public/definitions/channel.js";
import {
  createCrossChannelReceiveFn,
  toCrossChannelTargets,
} from "#channel/cross-channel-receive.js";
import type { RouteHandlerArgs, WebSocketRouteHooks } from "#channel/routes.js";
import { createSendFn } from "#channel/send.js";
import { createGetSessionFn } from "#channel/session.js";
import { createLogger, logError } from "#internal/logging.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";

const log = createLogger("channel.dispatch");

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
 * Two dispatch shapes: authored channels (`defineChannel` and its
 * wrappers) carry a `handler` field and receive `RouteHandlerArgs` with
 * `send`, `getSession`, etc. Framework-internal channels (the
 * connection callback route) build `ResolvedChannelDefinition` directly
 * with just `fetch` and receive a `RouteContext` carrying `agent`.
 */
export async function dispatchChannelRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<Response> {
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

  const routeArgs = buildRouteArgs(event, bundle, matchedChannel.name);

  let response: Response;

  try {
    if (matchedChannel.handler) {
      // Authored CompiledChannel route — build RouteHandlerArgs.
      response = await matchedChannel.handler(event.req, routeArgs.args);
    } else {
      // Framework-internal fetch-only channel (e.g. the connection
      // callback route). Build a RouteContext with the agent handle.
      const ctx: RouteContext = {
        agent: bundle.runtime,
        waitUntil: routeArgs.args.waitUntil,
        params: routeArgs.args.params,
        requestIp: routeArgs.args.requestIp,
      };

      response = await matchedChannel.fetch(event.req, ctx);
    }
  } catch (error) {
    // Without this a handler throw is only Nitro's default 5xx, with no eve log.
    const errorId = logError(log, "channel handler threw", error, {
      routeKey,
      channel: matchedChannel.name,
    });
    flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);
    return Response.json({ error: "Channel handler failed.", errorId, ok: false }, { status: 500 });
  }

  flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);

  return response;
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

  const routeArgs = buildRouteArgs(event, bundle, matchedChannel.name);

  try {
    const hooks = await matchedChannel.websocket(event.req, routeArgs.args);
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

function buildRouteArgs(
  event: H3Event,
  bundle: Awaited<ReturnType<typeof resolveNitroChannelRuntimeBundle>>,
  channelName: string,
): { args: RouteHandlerArgs; backgroundTasks: Promise<unknown>[] } {
  const requestIp = extractSocketIp(event);
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
  const send = createSendFn(bundle.runtime, adapter, channelName);
  const getSession = createGetSessionFn(bundle.runtime);
  const receive = createCrossChannelReceiveFn(
    bundle.runtime,
    toCrossChannelTargets(bundle.channels),
  );

  return {
    args: {
      send,
      getSession,
      receive,
      params,
      waitUntil,
      requestIp,
    },
    backgroundTasks,
  };
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

function extractSocketIp(event: H3Event): string | null {
  const ip = event.req.ip;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}
