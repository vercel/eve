import {
  EVE_BASE_URL_ENV,
  resolveSharedFrontendDevServer,
  type EveProcessHandle,
} from "#internal/nitro/host/shared-frontend-dev-server.js";

export { EVE_BASE_URL_ENV };
export type { EveProcessHandle };

/**
 * Resolve a shared eve dev server for {@link appRoot}, reusing a healthy
 * registered server when one exists and otherwise spawning a new one behind a
 * cross-process lock so concurrent Nuxt processes don't each boot eve.
 */
export async function resolveSharedEveDevServer(appRoot: string): Promise<EveProcessHandle> {
  return resolveSharedFrontendDevServer({ appRoot, framework: "nuxt" });
}
