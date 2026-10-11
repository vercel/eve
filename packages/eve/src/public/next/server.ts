import {
  resolveSharedEveDevServer,
  startEveProductionServer,
  type EveFrameworkHost,
  type EveProcessHandle,
} from "#shared/framework-eve-server.js";

const EVE_BASE_URL_ENV = "EVE_BASE_URL";
export const NEXT_PHASE_PRODUCTION_BUILD = "phase-production-build";
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

export async function resolveEveDestinationPrefix(input: {
  readonly appRoot: string;
  readonly devServerTimeoutMs?: number;
  readonly logLabel?: string;
  readonly phase: string;
  readonly productionDestinationPrefix: string;
  readonly productionServerOrigin?: string;
  /** Workspace member selected when spawning the local eve dev server. */
  readonly workspaceAgentName?: string;
}): Promise<string> {
  const state = getGlobalState();

  if (process.env.NODE_ENV === "production") {
    if (input.phase === NEXT_PHASE_PRODUCTION_BUILD) {
      return input.productionDestinationPrefix;
    }

    const key = `production:${input.appRoot}`;
    let productionServer = state.servers.get(key);
    if (productionServer === undefined) {
      productionServer =
        process.env.VERCEL || input.productionServerOrigin === undefined
          ? undefined
          : startEveProductionServer({
              appRoot: input.appRoot,
              host: EVE_NEXT_HOST,
              origin: input.productionServerOrigin,
            });
      if (productionServer !== undefined) {
        productionServer = productionServer.catch((error) => {
          state.servers.delete(key);
          throw error;
        });
        state.servers.set(key, productionServer);
      }
    }

    if (productionServer !== undefined) {
      return (await productionServer).origin;
    }

    return input.productionDestinationPrefix;
  }

  const configuredEveBaseUrl = readEveBaseUrlEnvironment();
  if (configuredEveBaseUrl !== undefined) {
    return configuredEveBaseUrl;
  }

  if (process.env.NODE_ENV !== "development") {
    return input.productionDestinationPrefix;
  }

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
