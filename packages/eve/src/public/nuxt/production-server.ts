import cluster from "node:cluster";
import { existsSync, realpathSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

import {
  startEveProductionServer,
  type EveFrameworkHost,
  type EveProcessHandle,
} from "#shared/framework-eve-server.js";

const EVE_NUXT_HOST: EveFrameworkHost = { label: "Nuxt", slug: "nuxt" };
const globalStateSymbol = Symbol.for("eve.nuxt.production-server");

interface EveNuxtProductionServerState {
  server?: Promise<EveProcessHandle>;
  readonly controller: AbortController;
}

interface EveNuxtProductionServerConfig {
  readonly origin: string;
  readonly relativeRoot: string;
}

interface EveNitroRequest {
  readonly path: string;
  readonly node: { readonly res: Pick<ServerResponse, "statusCode" | "end"> };
}

interface EveNitroApp {
  readonly hooks: {
    hook(name: "request", handler: (event: EveNitroRequest) => Promise<void>): unknown;
    hook(name: "close", handler: () => Promise<void>): unknown;
  };
}

function getGlobalState(): EveNuxtProductionServerState {
  const globalWithState = globalThis as typeof globalThis & {
    [globalStateSymbol]?: EveNuxtProductionServerState;
  };

  globalWithState[globalStateSymbol] ??= { controller: new AbortController() };
  return globalWithState[globalStateSymbol];
}

function assertDistinctServerOutput(appRoot: string): void {
  const serverEntry = join(appRoot, ".output", "server", "index.mjs");
  const runningEntry = process.argv[1];
  const sameEntry =
    runningEntry !== undefined &&
    (resolve(serverEntry) === resolve(runningEntry) ||
      (existsSync(serverEntry) &&
        existsSync(runningEntry) &&
        realpathSync.native(serverEntry) === realpathSync.native(runningEntry)));

  if (appRoot === process.cwd() || sameEntry) {
    throw new Error(
      `${serverEntry} is the Nuxt server output, not a separate eve build. Build eve from a separate eveRoot directory, or set EVE_NUXT_PRODUCTION_ROOT to that directory at startup. To manage eve yourself, set EVE_NUXT_PRODUCTION_ORIGIN when building Nuxt.`,
    );
  }
}

/** Start the built eve server once per process using the Nuxt build's proxy destination. */
export async function ensureEveProductionServer(
  config: EveNuxtProductionServerConfig,
): Promise<void> {
  if (cluster.isWorker || !isMainThread) {
    throw new Error(
      "eve managed Nuxt startup requires a single Node.js process, not cluster or worker deployments. Set EVE_NUXT_PRODUCTION_ORIGIN to an externally managed eve service when building Nuxt.",
    );
  }
  const configuredRoot = process.env.EVE_NUXT_PRODUCTION_ROOT?.trim();
  const appRoot = resolve(process.cwd(), configuredRoot || config.relativeRoot);
  assertDistinctServerOutput(appRoot);

  const state = getGlobalState();
  state.server ??= startEveProductionServer({
    appRoot,
    host: EVE_NUXT_HOST,
    origin: config.origin,
    portRetryHint: "set EVE_NUXT_PRODUCTION_PORT to another port and rebuild Nuxt",
    signal: state.controller.signal,
  }).catch((error: unknown) => {
    state.server = undefined;
    throw error;
  });

  await state.server;
}

/** Install managed startup and its readiness gate in the built Nuxt server. */
export default function createEveProductionServerPlugin(config: EveNuxtProductionServerConfig) {
  return (nitroApp: EveNitroApp): void => {
    const ready = ensureEveProductionServer(config).then(
      () => true,
      (error: unknown) => {
        console.error("[eve] failed to start the eve production server.", error);
        return false;
      },
    );
    nitroApp.hooks.hook("close", async () => {
      const state = getGlobalState();
      const server = state.server;
      state.controller.abort();
      const handle = await server?.catch(() => undefined);
      await handle?.close?.();
    });
    nitroApp.hooks.hook("request", async (event) => {
      const path = event.path.split("?")[0] ?? "";
      if (path !== EVE_ROUTE_PREFIX && !path.startsWith(`${EVE_ROUTE_PREFIX}/`)) return;
      if (await ready) return;
      event.node.res.statusCode = 503;
      event.node.res.end("eve production server is unavailable.");
    });
  };
}
