type FetchHandler = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  baseFetch: typeof fetch,
) => Promise<Response>;

type Registry = {
  handlers: Map<string, FetchHandler>;
  dispatch: typeof fetch;
  baseFetch: typeof fetch;
};

// Each eval is bundled separately, so module-local state cannot coordinate its registrations.
const registryKey = Symbol.for("eve.e2e.agent-basic-runtime.fetch-interceptor");
const sharedGlobal = globalThis as typeof globalThis & { [key: symbol]: Registry | undefined };

export function interceptFetchOrigin(origin: string, handler: FetchHandler): () => void {
  let registry = sharedGlobal[registryKey];
  if (registry?.handlers.has(origin))
    throw new Error(`Fetch origin already intercepted: ${origin}`);
  if (!registry) {
    const baseFetch = globalThis.fetch;
    const handlers = new Map<string, FetchHandler>();
    const dispatch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const route = handlers.get(url.origin);
      return route ? route(input, init, baseFetch) : baseFetch(input, init);
    };
    registry = { handlers, dispatch, baseFetch };
    sharedGlobal[registryKey] = registry;
    globalThis.fetch = dispatch;
  }
  registry.handlers.set(origin, handler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    registry.handlers.delete(origin);
    if (registry.handlers.size === 0) {
      if (globalThis.fetch === registry.dispatch) globalThis.fetch = registry.baseFetch;
      if (sharedGlobal[registryKey] === registry) delete sharedGlobal[registryKey];
    }
  };
}
