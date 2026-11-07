const EVE_NUXT_PRODUCTION_ORIGIN_ENV = "EVE_NUXT_PRODUCTION_ORIGIN";
const EVE_NUXT_PRODUCTION_PORT_ENV = "EVE_NUXT_PRODUCTION_PORT";
const DEFAULT_EVE_NUXT_PRODUCTION_PORT = 4274;

/**
 * Resolve the origin serving one eve agent in non-Vercel production: an
 * explicit override (`EVE_NUXT_PRODUCTION_ORIGIN`) or a local port. Workspace
 * members run as separate servers, so each takes the next port from the base.
 * On Vercel the module routes at the edge through a Build Output service
 * instead.
 */
export function resolveProductionOrigin(portOffset: number): string {
  const configuredOrigin = process.env[EVE_NUXT_PRODUCTION_ORIGIN_ENV];
  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return new URL(configuredOrigin.trim()).origin;
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

  const port = basePort + portOffset;
  if (port > 65_535) {
    throw new Error(`${EVE_NUXT_PRODUCTION_PORT_ENV} plus the eve agent count exceeds 65535.`);
  }
  return `http://127.0.0.1:${String(port)}`;
}
