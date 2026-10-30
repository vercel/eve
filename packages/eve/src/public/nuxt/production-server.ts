import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  startEveProductionServer,
  type EveFrameworkHost,
  type EveProcessHandle,
} from "#shared/framework-eve-server.js";

const EVE_NUXT_HOST: EveFrameworkHost = { label: "Nuxt", slug: "nuxt" };
const globalStateSymbol = Symbol.for("eve.nuxt.production-server");

interface EveNuxtProductionServerState {
  server?: Promise<EveProcessHandle>;
}

function getGlobalState(): EveNuxtProductionServerState {
  const globalWithState = globalThis as typeof globalThis & {
    [globalStateSymbol]?: EveNuxtProductionServerState;
  };

  globalWithState[globalStateSymbol] ??= {};
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
export async function ensureEveProductionServer(config: {
  readonly origin: string;
  readonly relativeRoot: string;
}): Promise<void> {
  const configuredRoot = process.env.EVE_NUXT_PRODUCTION_ROOT?.trim();
  const appRoot = resolve(process.cwd(), configuredRoot || config.relativeRoot);
  assertDistinctServerOutput(appRoot);

  const state = getGlobalState();
  state.server ??= startEveProductionServer({
    appRoot,
    host: EVE_NUXT_HOST,
    origin: config.origin,
    portRetryHint: "set EVE_NUXT_PRODUCTION_PORT to another port and rebuild Nuxt",
  }).catch((error: unknown) => {
    state.server = undefined;
    throw error;
  });

  await state.server;
}
