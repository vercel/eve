import { contextStorage } from "#context/container.js";
import { instrumentationSetupDeferred } from "#instrumentation/providers.js";

interface BuiltServer {
  fetch(request: Request): Response | Promise<Response>;
}

export interface EntryFetchOptions {
  waitUntil?(work: Promise<unknown>): void;
}

export interface EntryApp {
  fetch(request: Request, options?: EntryFetchOptions): Promise<Response>;
}

export function createEntryAppStart(
  loadServer: () => Promise<{ readonly default: BuiltServer }>,
): () => Promise<EntryApp> {
  let started = false;
  return async () => {
    if (started) {
      throw new Error(
        "start() from eve:app was already called. Keep the app from the first call and pass it to the code that serves requests.",
      );
    }
    if (!instrumentationSetupDeferred()) {
      throw new Error(
        "start() from eve:app ran before eve:instrumentation was imported. Import eve:instrumentation first in your entry, before eve:app.",
      );
    }
    if (contextStorage.kind !== "async-local-storage") {
      throw new Error(
        "start() from eve:app needs AsyncLocalStorage to serve requests. Without it, concurrent requests share one eve context and can act with each other's identity. Run the entry on a runtime that provides AsyncLocalStorage as a global, or build it with the node export condition.",
      );
    }
    started = true;
    const server = (await loadServer()).default;
    return {
      async fetch(request, options) {
        if (options?.waitUntil !== undefined) {
          Object.assign(request, { waitUntil: options.waitUntil });
        }
        return await server.fetch(request);
      },
    };
  };
}
