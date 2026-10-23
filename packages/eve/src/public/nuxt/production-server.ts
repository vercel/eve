import { join, resolve } from "node:path";

import {
  startEveProductionServer,
  type EveFrameworkHost,
  type EveProcessHandle,
} from "#shared/framework-eve-server.js";

import { readLocalProductionOrigin } from "./routing.js";

const EVE_NUXT_PRODUCTION_ORIGIN_ENV = "EVE_NUXT_PRODUCTION_ORIGIN";
const EVE_NUXT_PRODUCTION_ROOT_ENV = "EVE_NUXT_PRODUCTION_ROOT";
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

/**
 * Root the built eve output is served from. Defaults to the working directory
 * of the Nuxt server process, which is the project root for
 * `node .output/server/index.mjs`. Override with `EVE_NUXT_PRODUCTION_ROOT`
 * when the agent builds into another directory.
 */
function resolveProductionRoot(): string {
  const configuredRoot = process.env[EVE_NUXT_PRODUCTION_ROOT_ENV]?.trim();
  return configuredRoot === undefined || configuredRoot.length === 0
    ? process.cwd()
    : configuredRoot;
}

/**
 * `eve build` and `nuxt build` both write `.output/`, so an eve root that is
 * also the Nuxt root points at the running Nuxt server, which would respawn
 * itself for every boot.
 */
function assertDistinctServerOutput(appRoot: string): void {
  const serverEntry = join(appRoot, ".output", "server", "index.mjs");
  const runningEntry = process.argv[1];

  if (runningEntry !== undefined && resolve(serverEntry) === resolve(runningEntry)) {
    throw new Error(
      `${serverEntry} is the running Nuxt server, not an eve build. Build eve into another directory and set ${EVE_NUXT_PRODUCTION_ROOT_ENV} to it, or set ${EVE_NUXT_PRODUCTION_ORIGIN_ENV} to run eve yourself.`,
    );
  }
}

/**
 * Start the built eve server once per Nuxt server process so `/eve/v1/**`
 * resolves without a separately managed eve service.
 *
 * Does nothing on Vercel, where eve deploys as a sibling service, or when
 * `EVE_NUXT_PRODUCTION_ORIGIN` points eve routes at an origin the deployment
 * does not own.
 */
export async function ensureEveProductionServer(): Promise<void> {
  if (process.env.VERCEL) {
    return;
  }

  const configuredOrigin = process.env[EVE_NUXT_PRODUCTION_ORIGIN_ENV]?.trim();
  if (configuredOrigin !== undefined && configuredOrigin.length > 0) {
    return;
  }

  const appRoot = resolveProductionRoot();
  assertDistinctServerOutput(appRoot);

  const state = getGlobalState();
  state.server ??= startEveProductionServer({
    appRoot,
    host: EVE_NUXT_HOST,
    origin: readLocalProductionOrigin(),
    portRetryHint: "set EVE_NUXT_PRODUCTION_PORT to another port",
  }).catch((error: unknown) => {
    state.server = undefined;
    throw error;
  });

  await state.server;
}
