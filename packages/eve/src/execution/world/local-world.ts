import type { QueueWorld } from "./runtime-world.js";

// Workflow's local World (`@workflow/world-local`): runs, events and streams as files under a
// directory, for sessions on one machine that outlive the process. It loads the first time a
// session uses it, so importing eve doesn't load Workflow's World. Its own recovery, which would
// re-enqueue every active run in the directory through Workflow's queue, is off: eve continues
// its sessions itself. Its queue delivers in this process, to the handler a host registers.

export interface LocalWorldOptions {
  /** Where the World keeps its files. */
  readonly dataDir: string;
}

/** Workflow's local World in `options.dataDir`. */
export function localWorld(options: LocalWorldOptions): QueueWorld {
  let loading: Promise<QueueWorld> | undefined;
  let loaded: QueueWorld | undefined;
  const world = (): Promise<QueueWorld> =>
    (loading ??= import("#compiled/@workflow/world-local/index.js").then(({ createWorld }) => {
      loaded = createWorld({ dataDir: options.dataDir, recoverActiveRuns: false });
      return loaded;
    }));
  return {
    // The World's own, once a call loaded it (`getDeploymentId` does before a session's first write).
    get capabilities() {
      return loaded?.capabilities;
    },
    getDeploymentId: async () => await (await world()).getDeploymentId(),
    events: {
      create: async (runId, data, params) =>
        await (await world()).events.create(runId, data, params),
      list: async (params) => await (await world()).events.list(params),
    },
    hooks: { getByToken: async (token) => await (await world()).hooks.getByToken(token) },
    runs: {
      list: async (params) => await (await world()).runs.list(params),
      // Workflow's Worlds have it, so the fitted one does.
      get: async (runId, params) => await (await world()).runs.get!(runId, params),
    },
    streams: {
      close: async (runId, name) => await (await world()).streams.close(runId, name),
      getChunks: async (runId, name, chunks) =>
        await (await world()).streams.getChunks(runId, name, chunks),
      getInfo: async (runId, name) => await (await world()).streams.getInfo(runId, name),
      get: async (runId, name, startIndex) => {
        const { streams } = await world();
        if (streams.get === undefined) throw new Error("This World has no live stream read.");
        return await streams.get(runId, name, startIndex);
      },
      write: async (runId, name, chunk) => await (await world()).streams.write(runId, name, chunk),
    },
    queue: async (name, message, queueOptions) =>
      await (await world()).queue(name, message, queueOptions),
    createQueueHandler(prefix, handler) {
      let made: ((request: Request) => Promise<Response>) | undefined;
      return async (request) =>
        await (made ??= (await world()).createQueueHandler(prefix, handler))(request);
    },
    // Registered as the World loads, before any message this process sends can be delivered.
    registerHandler(prefix, handler) {
      void world().then((loadedWorld) => loadedWorld.registerHandler?.(prefix, handler));
    },
    start: async () => await (await world()).start?.(),
    close: async () => await loaded?.close?.(),
  };
}
