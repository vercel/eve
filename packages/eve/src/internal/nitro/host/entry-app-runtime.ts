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
