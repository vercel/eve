const EVE_NUXT_PRODUCTION_ORIGIN_ENV = "EVE_NUXT_PRODUCTION_ORIGIN";
const EVE_NUXT_PRODUCTION_PORT_ENV = "EVE_NUXT_PRODUCTION_PORT";
const DEFAULT_EVE_NUXT_PRODUCTION_PORT = 4274;

function readLocalProductionPort(): number {
  const configuredPort = process.env[EVE_NUXT_PRODUCTION_PORT_ENV];
  if (configuredPort === undefined || configuredPort.trim().length === 0) {
    return DEFAULT_EVE_NUXT_PRODUCTION_PORT;
  }
  const port = Number.parseInt(configuredPort, 10);
  if (String(port) !== configuredPort.trim() || port < 1 || port > 65_535) {
    throw new Error(`${EVE_NUXT_PRODUCTION_PORT_ENV} must be an integer between 1 and 65535.`);
  }
  return port;
}

/**
 * Resolve the origin serving the eve agents in non-Vercel production: an
 * explicit override (`EVE_NUXT_PRODUCTION_ORIGIN`) or a local port. On Vercel
 * the module routes at the edge through a Build Output service instead.
 */
export function resolveProductionOrigin(): string {
  const configuredOrigin = process.env[EVE_NUXT_PRODUCTION_ORIGIN_ENV];
  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return new URL(configuredOrigin.trim()).origin;
  }

  return `http://127.0.0.1:${String(readLocalProductionPort())}`;
}
