/**
 * Per-agent public route prefix minted into framework-owned callback URLs.
 *
 * In multi-agent mode (`withEve({ agents })`) each named agent mounts under
 * `/eve/agents/<name>/eve/v1/*`, and the Vercel route strips that prefix before
 * the request reaches the service — so the running function only ever sees the
 * bare `/eve/v1/*` path and cannot recover its own public prefix from the
 * request. The build injects the prefix as {@link PUBLIC_ROUTE_PREFIX_ENV} into
 * the workflow function's environment so callback URLs minted mid-turn resolve
 * back to the agent's own mount instead of a bare `/eve/v1/*` path nothing
 * serves.
 *
 * The prefix is empty for a single/unnamed agent (which IS mounted at bare
 * `/eve/v1/*`), so both helpers are no-ops there.
 */

/**
 * Environment variable carrying the current agent's public route prefix into
 * the generated workflow function at runtime. Written by the Vercel function
 * output writer; read by {@link resolveEvePublicRoutePrefix}.
 */
export const PUBLIC_ROUTE_PREFIX_ENV = "EVE_PUBLIC_ROUTE_PREFIX";

/**
 * Resolves the current agent's public route prefix (e.g. `/eve/agents/researcher`),
 * or the empty string when the agent is mounted at the bare `/eve/v1/*` root.
 */
export function resolveEvePublicRoutePrefix(): string {
  const prefix = process.env[PUBLIC_ROUTE_PREFIX_ENV]?.trim();
  if (!prefix) {
    return "";
  }
  return prefix.replace(/\/$/, "");
}

/**
 * Prepends the current agent's public route prefix to a framework-owned
 * callback path so the minted URL targets the agent's own mount.
 *
 * The path must be prefixed at mint time only — never in the shared
 * `#protocol/routes.js` builders, which also register the receiving routes that
 * run post-transform against the bare `/eve/v1/*` path.
 */
export function prefixFrameworkCallbackPath(path: string): string {
  return `${resolveEvePublicRoutePrefix()}${path}`;
}
