import { isCompiledChannel } from "#channel/compiled-channel.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import { createChannelRouteArgs } from "#channel/route-args.js";
import type { Runtime } from "#channel/types.js";
import { eveChannel } from "#eve-channel/index.js";
import { detached, matchRoute } from "#eve-channel/in-process.js";
import type { EveChannelConfig } from "#eve-channel/types.js";
import { sessionCommandErrorResponse } from "#eve-channel/support.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createResolvedModuleSourceRef } from "#runtime/resolve-helpers.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

// The channels of an agent compiled from files, served by a World host: each request goes to the
// channel route it matches, as Nitro's dispatch routes it, with the host's runtime for the agent
// (`front.ts`) where a deployment's would be Workflow's. So a channel's sessions start, and its
// messages arrive, as entities on the World; framework routes the agent has, such as eve's own
// channel and the sign-in callback, are served the same way.

const log = createLogger("execution.world-host.channels");

export interface WorldHostChannelsOptions {
  readonly agentName: string;
  /** The channels it serves, in the order requests are matched against them. */
  readonly channels: () => Promise<readonly ResolvedChannelDefinition[]>;
  /** The host's runtime for the agent. */
  readonly runtime: Runtime;
  /** Work a route keeps going after its response; a serverless platform's `waitUntil`. */
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

/** A `fetch` that serves the agent's channels; a request no channel matches is a 404. */
export function worldHostChannels(
  options: WorldHostChannelsOptions,
): (request: Request) => Promise<Response> {
  const { agentName, runtime } = options;
  let channels: Promise<readonly ResolvedChannelDefinition[]> | undefined;
  const channelsOf = () => (channels ??= options.channels());

  return async (request) => {
    const path = new URL(request.url).pathname;
    const all = await channelsOf();
    let matched: { channel: ResolvedChannelDefinition; params: Record<string, string> } | undefined;
    for (const channel of all) {
      if (channel.method.toUpperCase() !== request.method) continue;
      const params = matchRoute(channel.urlPath, path);
      if (params !== undefined) {
        matched = { channel, params };
        break;
      }
    }
    if (matched === undefined)
      return Response.json(
        { error: "No matching channel for this request.", ok: false },
        { status: 404 },
      );
    const { channel, params } = matched;
    const waitUntil = (task: Promise<unknown>) => {
      const logged = Promise.resolve(task).catch((error: unknown) =>
        logError(log, "channel background task failed", error, { channel: channel.name }),
      );
      if (options.waitUntil !== undefined) options.waitUntil(logged);
    };
    const unsupported = (what: string) => async (): Promise<never> => {
      throw new Error(`${what} isn't available on a World host yet.`);
    };
    const deliverySource = {
      channelKind: channel.adapter?.kind ?? "channel",
      channelName: channel.name,
    };
    try {
      if (channel.handler === undefined) {
        // A framework route (the sign-in callback, a webhook): it reads only its context.
        const ctx: RouteContext = { params, requestIp: null, waitUntil };
        return detached(await channel.fetch(request, ctx), request.signal);
      }
      const args = createChannelRouteArgs({
        adapter: channel.adapter ?? { kind: "channel" },
        agent: {
          describe: unsupported("Describing the agent"),
          invokeTool: unsupported("Running a tool outside a session"),
          listSkillFiles: unsupported("Listing skill files"),
          readSkill: unsupported("Reading skill files"),
        },
        agentInfo: async () =>
          Response.json(
            { error: "This agent has no inspection payload.", ok: false },
            { status: 404 },
          ),
        agentName,
        deliverySource,
        params,
        requestIp: null,
        runtime,
        to: createCrossChannelToFn(runtime, toCrossChannelTargets(all)),
        turnPolicy: channel.turnPolicy,
        waitUntil,
      });
      return detached(await channel.handler(request, args), request.signal);
    } catch (error) {
      const commandError = sessionCommandErrorResponse(error);
      if (commandError !== undefined) return commandError;
      const errorId = logError(log, "channel handler threw", error, {
        channel: channel.name,
        path,
      });
      return Response.json(
        { error: "Channel handler failed.", errorId, ok: false },
        { status: 500 },
      );
    }
  };
}

/** The channels of an agent compiled from files: its own, and the framework's. */
export function compiledAgentChannels(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): () => Promise<readonly ResolvedChannelDefinition[]> {
  return async () =>
    (await getCompiledRuntimeAgentBundle({ compiledArtifactsSource })).graph.root.channels;
}

/**
 * eve's own channel as an agent defined in code has it: `eveChannel(config)`'s HTTP routes (the
 * session protocol, and the sign-in callback), as a compiled agent gets its framework eve channel
 * (`channels/eve.ts`), with the auth `config` names in place of the deployment's.
 */
export function eveChannelDefinitions(
  config: EveChannelConfig,
): readonly ResolvedChannelDefinition[] {
  const channel = eveChannel(config);
  const sourceRef = createResolvedModuleSourceRef({
    exportName: undefined,
    logicalPath: "channels/eve.ts",
    sourceId: "eve:root-defaults",
  });
  return channel.routes.flatMap((route): ResolvedChannelDefinition[] =>
    route.transport === "websocket"
      ? []
      : [
          {
            name: "eve",
            method: route.method,
            urlPath: route.path,
            // Dispatch calls `handler`, as it does a compiled channel's.
            fetch: async () =>
              Response.json({ error: "No matching route handler.", ok: false }, { status: 404 }),
            handler: route.handler,
            receive: channel.receive,
            ...(isCompiledChannel(channel) && { adapter: channel.adapter, definition: channel }),
            turnPolicy: channel.turnPolicy,
            ...sourceRef,
          },
        ],
  );
}
