import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

/**
 * Private route namespace for hosting eve as a separate experimental Vercel
 * service behind the SvelteKit app.
 */
export const EVE_SVELTEKIT_SERVICE_PREFIX = "/_eve_internal/eve";

/**
 * Normalize a user-supplied service prefix into a leading-slash, no-trailing-
 * slash route. Throws when the prefix resolves to the root route, which would
 * collide with the SvelteKit web service.
 */
export function normalizeRoutePrefix(prefix: string): string {
  const prefixed = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const normalized = prefixed.replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new Error("eve SvelteKit service prefix cannot resolve to the root route.");
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
 * A Vercel rewrite that forwards eve transport requests (`/eve/v1/**`) to the
 * private eve service prefix (`/_eve_internal/eve/eve/v1/**`).
 */
export interface EveVercelRewrite {
  readonly destination: string;
  readonly source: string;
}

/**
 * Build the Vercel rewrite that forwards browser eve transport requests to the
 * sibling eve service.
 */
export function createEveVercelRewrite(servicePrefix: string): EveVercelRewrite {
  return {
    destination: `${joinRoutePrefix(servicePrefix, EVE_ROUTE_PREFIX)}/:path*`,
    source: `${EVE_ROUTE_PREFIX}/:path*`,
  };
}
