import {
  resolveSharedEveDevServer,
  startEveProductionServer,
  type EveFrameworkHost,
  type EveProcessHandle,
} from "#shared/framework-eve-server.js";

const EVE_BASE_URL_ENV = "EVE_BASE_URL";
export const NEXT_PHASE_PRODUCTION_BUILD = "phase-production-build";
export const NEXT_PHASE_PRODUCTION_SERVER = "phase-production-server";
export const EVE_NEXT_HOST: EveFrameworkHost = { label: "Next.js", slug: "next" };

interface EveNextGlobalState {
  readonly servers: Map<string, Promise<EveProcessHandle>>;
}

const globalStateSymbol = Symbol.for("eve.next.state");

function getGlobalState(): EveNextGlobalState {
  const globalWithState = globalThis as typeof globalThis & {
    [globalStateSymbol]?: EveNextGlobalState;
  };

  globalWithState[globalStateSymbol] ??= {
    servers: new Map(),
  };

  return globalWithState[globalStateSymbol];
}

function readEveBaseUrlEnvironment(): string | undefined {
  const configuredUrl = process.env[EVE_BASE_URL_ENV];

  if (configuredUrl === undefined || configuredUrl.trim().length === 0) {
    return undefined;
  }

  return new URL(configuredUrl).origin;
}

/**
 * Start the built eve server for `appRoot` on `origin` once per process. Named
 * agents may share a root, each on its own port, so both identify the server.
 * `next start` calls this while loading config, because Next serves the
 * rewrites saved by `next build` and never calls `rewrites()` again.
 */
export async function ensureEveProductionServer(input: {
  readonly appRoot: string;
  readonly origin: string;
}): Promise<void> {
  const state = getGlobalState();
  const key = `production:${input.appRoot}:${input.origin}`;
  let server = state.servers.get(key);
  if (server === undefined) {
    server = startEveProductionServer({
      appRoot: input.appRoot,
      host: EVE_NEXT_HOST,
      origin: input.origin,
    }).catch((error: unknown) => {
      state.servers.delete(key);
      throw error;
    });
    state.servers.set(key, server);
  }
  await server;
}

export async function resolveEveDestinationPrefix(input: {
  readonly appRoot: string;
  readonly devServerTimeoutMs?: number;
  readonly logLabel?: string;
  readonly productionDestinationPrefix: string;
  /** Workspace member selected when spawning the local eve dev server. */
  readonly workspaceAgentName?: string;
}): Promise<string> {
  if (process.env.NODE_ENV === "production") {
    return input.productionDestinationPrefix;
  }

  const configuredEveBaseUrl = readEveBaseUrlEnvironment();
  if (configuredEveBaseUrl !== undefined) {
    return configuredEveBaseUrl;
  }

  if (process.env.NODE_ENV !== "development") {
    return input.productionDestinationPrefix;
  }

  const state = getGlobalState();
  const key = `dev:${input.appRoot}`;
  let server = state.servers.get(key);

  if (server === undefined) {
    server = resolveSharedEveDevServer({
      appRoot: input.appRoot,
      host: EVE_NEXT_HOST,
      logLabel: input.logLabel,
      timeoutMs: input.devServerTimeoutMs,
      workspaceAgentName: input.workspaceAgentName,
    }).catch((error) => {
      state.servers.delete(key);
      throw error;
    });
    state.servers.set(key, server);
  }

  return (await server).origin;
}
