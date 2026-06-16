import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

/**
 * Private route namespace used when a Vercel deployment hosts eve as a
 * separate experimental service behind the Nuxt app.
 */
export const EVE_NUXT_SERVICE_PREFIX = "/_eve_internal/eve";

const EVE_NUXT_PRODUCTION_ORIGIN_ENV = "EVE_NUXT_PRODUCTION_ORIGIN";
const EVE_NUXT_PRODUCTION_PORT_ENV = "EVE_NUXT_PRODUCTION_PORT";
const DEFAULT_EVE_NUXT_PRODUCTION_PORT = 4274;

/**
 * Normalize a user-supplied service prefix into a leading-slash, no-trailing-
 * slash route. Throws when the prefix resolves to the root route, which would
 * collide with the Nuxt web service.
 */
export function normalizeRoutePrefix(prefix: string): string {
  const prefixed = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const normalized = prefixed.replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new Error("eve Nuxt service prefix cannot resolve to the root route.");
  }
  return normalized;
}

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

/**
 * Resolve the local production port the module proxies to when an eve service
 * runs alongside a non-Vercel Nuxt deployment. Defaults to
 * {@link DEFAULT_EVE_NUXT_PRODUCTION_PORT}.
 */
export function readLocalProductionPort(): number {
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
 * An edge-level Vercel rewrite expressed in Build Output API v3 form.
 */
export interface EveVercelRewriteRoute {
  readonly src: string;
  readonly dest: string;
  /**
   * Re-run route matching against the rewritten `dest`. Required so the
   * rewritten eve service path is routed to the sibling eve service instead of
   * being resolved inside the host service's own filesystem (which 404s).
   */
  readonly check: true;
}

/**
 * Build the edge-level Vercel rewrite that forwards eve transport requests
 * (`/eve/v1/**`) to the eve service prefix (`/_eve_internal/eve/eve/v1/**`).
 *
 * Mirrors the Next.js integration's `beforeFiles` rewrite. A Nitro runtime
 * `proxy` route rule cannot reach a sibling Vercel service — the proxied
 * request loops back into the Nuxt function and 404s — so production routing
 * must happen at the edge via the build output config instead.
 */
export function createEveVercelRewriteRoute(servicePrefix: string): EveVercelRewriteRoute {
  const destinationPrefix = joinRoutePrefix(servicePrefix, EVE_ROUTE_PREFIX);
  return {
    src: `^${EVE_ROUTE_PREFIX}/(.*)$`,
    dest: `${destinationPrefix}/$1`,
    check: true,
  };
}

/**
 * Resolve the proxy destination for eve routes in production.
 *
 * On Vercel the destination is the private service prefix. Off Vercel it is an
 * explicit origin override (`EVE_NUXT_PRODUCTION_ORIGIN`) or a local port.
 */
export function resolveProductionTarget(servicePrefix: string): string {
  if (process.env.VERCEL) {
    return joinRoutePrefix(servicePrefix, EVE_ROUTE_PREFIX);
  }

  const configuredOrigin = process.env[EVE_NUXT_PRODUCTION_ORIGIN_ENV];
  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return joinRoutePrefix(normalizeOrigin(configuredOrigin), EVE_ROUTE_PREFIX);
  }

  const localOrigin = `http://127.0.0.1:${String(readLocalProductionPort())}`;
  return joinRoutePrefix(localOrigin, EVE_ROUTE_PREFIX);
}
