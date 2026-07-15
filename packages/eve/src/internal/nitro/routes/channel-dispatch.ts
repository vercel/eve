import type { H3Event } from "nitro";
import type { Agent, RouteContext } from "#public/definitions/channel.js";
import {
  createCrossChannelReceiveFn,
  toCrossChannelTargets,
} from "#channel/cross-channel-receive.js";
import type { DeliverInput, RunInput, Runtime } from "#channel/types.js";
import type { RouteHandlerArgs, WebSocketRouteHooks } from "#channel/routes.js";
import { createSendFn } from "#channel/send.js";
import { createGetSessionFn } from "#channel/session.js";
import { createLogger, logError } from "#internal/logging.js";
import { readTrustedDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteAgent,
} from "#internal/nitro/routes/channel-route-context.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { withVercelOidcProjectResolver } from "#runtime/governance/auth/vercel-oidc-project.js";

const log = createLogger("channel.dispatch");

interface BuiltRouteArgs {
  readonly agent: Agent;
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
        agent: routeArgs.agent,
        waitUntil: routeArgs.args.waitUntil,
        params: routeArgs.args.params,
        requestIp: routeArgs.args.requestIp,
      };

      return await matchedChannel.fetch(event.req, ctx);
    });
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
  const agent = createRouteAgent(bundle.runtime, requestId);
  const send = createSendFn(bundle.runtime, adapter, channelName, { requestId });
  const getSession = createGetSessionFn(bundle.runtime);
  const receive = createCrossChannelReceiveFn(
    bundle.runtime,
    toCrossChannelTargets(bundle.channels),
  );

  const args = attachRouteAgent(
    attachAgentInfoRouteResponse(
      {
        send,
        getSession,
        receive,
        params,
        waitUntil,
        requestIp,
      },
      async () => {
        const { handleAgentInfoRequest } = await import("#internal/nitro/routes/info.js");
        return await handleAgentInfoRequest(config);
      },
    ),
    agent,
  );

  return {
    agent,
    args,
    backgroundTasks,
  };
}

function createRouteAgent(runtime: Runtime, requestId: string | undefined): Agent {
  return {
    async cancelTurn(input) {
      return await runtime.cancelTurn(input);
    },
    async deliver(input) {
      const deliverInput: DeliverInput = { ...input, requestId }; // Avoid mutating a frozen caller input.
      return await runtime.deliver(deliverInput);
    },
    async getEventStream(sessionId, options) {
      return await runtime.getEventStream(sessionId, options);
    },
    async run(input) {
      const runInput: RunInput = { ...input, requestId }; // Avoid mutating a frozen caller input.
      return await runtime.run(runInput);
    },
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
