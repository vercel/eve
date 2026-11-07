import { isCompiledChannel } from "#channel/compiled-channel.js";
import { createChannelRouteArgs, type ChannelRoutePorts } from "#channel/route-args.js";
import type { HttpRouteDefinition } from "#channel/routes.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { eveChannel } from "#eve-channel/index.js";
import { sessionCommandErrorResponse } from "#eve-channel/support.js";
import type { EveAuthResult } from "#eve-channel/types.js";
import { createLogger, logError } from "#internal/logging.js";

// The eve channel served to requests made in this process: a `fetch` that routes each `Request`
// to the channel's own route handler, with the arguments Nitro's dispatch would give it
// (`createChannelRouteArgs`), over any `Runtime`, typically an in-process one. `eve/client`, and
// so the `eve dev` TUI, drive an agent through it without an HTTP server or Nitro.

const log = createLogger("eve.channel.in-process");

export interface InProcessChannelOptions {
  /** Where sessions run. */
  readonly runtime: Runtime;
  readonly agentName: string;
  /**
   * Who sends every request: the host's own user, as an embedded session's caller. It may read
   * `GET /eve/v1/info`, as a developer at their own `eve dev` server does.
   */
  readonly caller: SessionAuthContext;
  /** The channel's name, which namespaces continuation tokens: `eve` by default. */
  readonly channelName?: string;
}

/** A `fetch` for `ClientOptions.fetch` that serves the eve channel in this process. */
export function createInProcessChannelFetch(options: InProcessChannelOptions): typeof fetch {
  const { runtime, agentName, caller } = options;
  const channelName = options.channelName ?? "eve";
  const channel = eveChannel({
    auth: async (): Promise<EveAuthResult> => ({ ...caller, allowAgentInfo: true }),
  });
  const routes = channel.routes.flatMap((route) =>
    route.transport === "websocket" ? [] : [route],
  );
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} isn't available to an agent served in-process.`);
  };
  const ports: Omit<ChannelRoutePorts, "params"> = {
    // What `defineChannel` built: the adapter its deliveries go through.
    adapter: isCompiledChannel(channel) ? channel.adapter : { kind: "channel" },
    agent: {
      describe: unsupported("Describing the agent"),
      invokeTool: unsupported("Running a tool outside a session"),
      listSkillFiles: unsupported("Listing skill files"),
      readSkill: unsupported("Reading skill files"),
    },
    agentInfo: async () =>
      Response.json({ error: "This agent has no inspection payload.", ok: false }, { status: 404 }),
    agentName,
    deliverySource: { channelKind: "http", channelName },
    requestIp: null,
    runtime,
    to: () => {
      throw new Error("An agent served in-process has no other channels.");
    },
    turnPolicy: channel.turnPolicy,
    // Work a route keeps going after its response, such as a stream's tail, runs on; a task
    // that fails is logged, as Nitro's dispatch logs it.
    waitUntil: (task) => {
      void Promise.resolve(task).catch((error: unknown) =>
        logError(log, "channel background task failed", error, { channelName }),
      );
    },
  };

  return async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const params = matchRoute(route, path);
      if (params === undefined) continue;
      try {
        return detached(
          await route.handler(request, createChannelRouteArgs({ ...ports, params })),
          request.signal,
        );
      } catch (error) {
        const commandError = sessionCommandErrorResponse(error);
        if (commandError !== undefined) return commandError;
        const errorId = logError(log, "channel handler threw", error, { channelName, path });
        return Response.json(
          { error: "Channel handler failed.", errorId, ok: false },
          { status: 500 },
        );
      }
    }
    return Response.json(
      { error: "No matching channel for this request.", ok: false },
      { status: 404 },
    );
  };
}

/**
 * `response` with a body of its own, as one that crossed a network: the client reads and cancels
 * its copy, and the server's stream ends when the client stops reading or the request aborts.
 */
function detached(response: Response, signal: AbortSignal): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const stop = (reason?: unknown) => {
    try {
      void reader.cancel(reason).catch(() => {});
    } catch {
      // A stream that already ended has nothing to stop.
    }
  };
  signal.addEventListener("abort", () => stop(signal.reason), { once: true });
  const body = new ReadableStream<Uint8Array>({
    cancel: stop,
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * The path parameters `path` gives `route`'s pattern (`/a/:b/c`), or `undefined` when it doesn't
 * match. Parameters are decoded except `%2F` and `%5C`, as Nitro's router leaves them.
 */
function matchRoute(
  route: HttpRouteDefinition<undefined>,
  path: string,
): Record<string, string> | undefined {
  const want = route.path.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of want.entries()) {
    const actual = got[index] ?? "";
    if (segment.startsWith(":")) {
      if (actual === "") return undefined;
      params[segment.slice(1)] = decodeURIComponent(actual.replace(/%(2F|5C)/gi, "%25$1"));
    } else if (segment !== actual) return undefined;
  }
  return params;
}
