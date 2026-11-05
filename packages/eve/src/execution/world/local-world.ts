import type { RuntimeWorld } from "./runtime-world.js";

// Workflow's local World (`@workflow/world-local`): runs, events and streams as files under a
// directory, for sessions on one machine that outlive the process. It loads the first time a
// session uses it, so importing eve doesn't load Workflow's World. Its own recovery, which would
// re-enqueue every active run in the directory through Workflow's queue, is off: eve continues
// its sessions itself.

export interface LocalWorldOptions {
  /** Where the World keeps its files. */
  readonly dataDir: string;
}

/** Workflow's local World in `options.dataDir`. */
export function localWorld(options: LocalWorldOptions): RuntimeWorld {
  let loading: Promise<RuntimeWorld> | undefined;
  let loaded: RuntimeWorld | undefined;
  const world = (): Promise<RuntimeWorld> =>
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
    runs: { list: async (params) => await (await world()).runs.list(params) },
    streams: {
      close: async (runId, name) => await (await world()).streams.close(runId, name),
      getChunks: async (runId, name, chunks) =>
        await (await world()).streams.getChunks(runId, name, chunks),
      getInfo: async (runId, name) => await (await world()).streams.getInfo(runId, name),
      write: async (runId, name, chunk) => await (await world()).streams.write(runId, name, chunk),
    },
  };
}
