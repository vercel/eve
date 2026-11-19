import { callAdapterEventHandler } from "#channel/adapter-event-handler.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { ContextAccessor, ContextKey } from "#context/key.js";
import { SessionKey } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { RouteHandlerArgs } from "#public/definitions/channel.js";

export function compiledChannel<TState = unknown>(channel: unknown): CompiledChannel<TState> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a CompiledChannel.");
  return channel as CompiledChannel<TState>;
}

export function stubSessionAccessor(): ContextAccessor {
  const accessor: ContextAccessor = {
    ensure: <T>(_key: ContextKey<T>, create: () => T) => create(),
    get: () => undefined,
    has: () => false,
    require<T>(key: ContextKey<T>): T {
      throw new Error(`Context key ${String(key)} is unavailable in this test.`);
    },
    set: <T>(_key: ContextKey<T>, updater: T | ((current: T | undefined) => T)) =>
      typeof updater === "function"
        ? (updater as (current: T | undefined) => T)(undefined)
        : updater,
  };
  enterSessionProjection(accessor, undefined);
  return accessor;
}

const sessionContext = (() => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "test-session",
    turn: { id: "test-turn", sequence: 0 },
  });
  enterSessionProjection(ctx, undefined);
  return ctx;
})();

export function channelEvent<T extends SessionEvent["type"]>(type: T, data: unknown): SessionEvent {
  return { data, type } as SessionEvent;
}

export function callChannelEvent(
  adapter: ChannelAdapter,
  event: SessionEvent,
  ctx: Parameters<typeof callAdapterEventHandler>[2],
): Promise<void> {
  return contextStorage.run(sessionContext, () => callAdapterEventHandler(adapter, event, ctx));
}

export async function postToChannelRoute<TState>(
  channel: CompiledChannel<TState>,
  request: Request,
  context: Pick<RouteHandlerArgs<TState>, "from" | "resolveSession">,
  onWaitUntil: (task: Promise<unknown>) => void = () => {},
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const route = channel.routes.find(
    (candidate) => candidate.method === request.method && candidate.path === path,
  );
  if (!route || !isHttpRouteDefinition(route)) {
    throw new Error(`Expected a ${request.method} ${path} route.`);
  }
  const tasks: Promise<unknown>[] = [];
  const response = await route.handler(request, {
    ...mockAgentRouteArgs(),
    ...context,
    attachSession: (() => undefined) as never,
    params: {},
    requestIp: null,
    to: (() => undefined) as never,
    waitUntil(task) {
      onWaitUntil(task);
      tasks.push(task);
    },
  });
  for (let drained = 0; drained < tasks.length;) {
    const pending = tasks.slice(drained);
    drained = tasks.length;
    await Promise.allSettled(pending);
  }
  return response;
}
