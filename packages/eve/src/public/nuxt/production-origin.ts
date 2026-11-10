import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const EVE_NUXT_PRODUCTION_ORIGIN_ENV = "EVE_NUXT_PRODUCTION_ORIGIN";
const EVE_NUXT_PRODUCTION_PORT_ENV = "EVE_NUXT_PRODUCTION_PORT";
const DEFAULT_EVE_NUXT_PRODUCTION_PORT = 4274;

/**
 * Resolve where one eve agent's routes proxy to in non-Vercel production.
 * An explicit override (`EVE_NUXT_PRODUCTION_ORIGIN`) is one host that mounts
 * every agent under its own public prefix (`/eve/v1` or `/eve/<name>/v1`), as
 * with `withEve`. Otherwise each agent runs as its own local server serving
 * `/eve/v1`, so workspace members take the next port from the base. On Vercel
 * the module routes at the edge through a Build Output service instead.
 */
export function resolveProductionTarget(input: {
  readonly portOffset: number;
  readonly publicPrefix: string;
}): string {
  const configuredOrigin = process.env[EVE_NUXT_PRODUCTION_ORIGIN_ENV];
  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return `${new URL(configuredOrigin.trim()).origin}${input.publicPrefix}`;
  }

  const configuredPort = process.env[EVE_NUXT_PRODUCTION_PORT_ENV];
  let basePort = DEFAULT_EVE_NUXT_PRODUCTION_PORT;
  if (configuredPort !== undefined && configuredPort.trim().length > 0) {
    const port = Number.parseInt(configuredPort, 10);
    if (String(port) !== configuredPort.trim() || port < 1 || port > 65_535) {
      throw new Error(`${EVE_NUXT_PRODUCTION_PORT_ENV} must be an integer between 1 and 65535.`);
    }
    basePort = port;
  }

  const port = basePort + input.portOffset;
  if (port > 65_535) {
    throw new Error(`${EVE_NUXT_PRODUCTION_PORT_ENV} plus the eve agent count exceeds 65535.`);
  }
  return `http://127.0.0.1:${String(port)}${EVE_ROUTE_PREFIX}`;
}
