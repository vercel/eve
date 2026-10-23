/**
 * Join a route prefix and a path with exactly one separating slash.
 */
export function joinRoutePrefix(prefix: string, path: string): string {
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Reduce an origin string to its canonical `protocol://host[:port]` form.
 */
export function normalizeOrigin(origin: string): string {
  return new URL(origin.trim()).origin;
}

const EVE_SVELTEKIT_PRODUCTION_ORIGIN_ENV = "EVE_SVELTEKIT_PRODUCTION_ORIGIN";
const EVE_SVELTEKIT_PRODUCTION_PORT_ENV = "EVE_SVELTEKIT_PRODUCTION_PORT";
const DEFAULT_EVE_SVELTEKIT_PRODUCTION_PORT = 4274;

/**
 * Resolve the local production port eve routes are forwarded to when the eve
 * service runs alongside a non-Vercel SvelteKit deployment. Defaults to
 * {@link DEFAULT_EVE_SVELTEKIT_PRODUCTION_PORT}.
 */
export function readLocalProductionPort(): number {
  const configuredPort = process.env[EVE_SVELTEKIT_PRODUCTION_PORT_ENV];
  if (configuredPort === undefined || configuredPort.trim().length === 0) {
    return DEFAULT_EVE_SVELTEKIT_PRODUCTION_PORT;
  }

  const port = Number.parseInt(configuredPort, 10);
  if (String(port) !== configuredPort.trim() || port < 1 || port > 65_535) {
    throw new Error(`${EVE_SVELTEKIT_PRODUCTION_PORT_ENV} must be an integer between 1 and 65535.`);
  }

  return port;
}

/**
 * Resolve the origin eve routes are forwarded to in non-Vercel production: an
 * explicit override (`EVE_SVELTEKIT_PRODUCTION_ORIGIN`) or a local port.
 */
export function resolveProductionOrigin(): string {
  const configuredOrigin = process.env[EVE_SVELTEKIT_PRODUCTION_ORIGIN_ENV];
  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return normalizeOrigin(configuredOrigin);
  }

  return `http://127.0.0.1:${String(readLocalProductionPort())}`;
}
