import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const EVE_NAMED_AGENT_MOUNT_PATTERN = /^\/eve\/[a-z0-9][a-z0-9_-]*$/;
const EVE_NAMED_AGENT_PROTOCOL_PATTERN = /^\/eve\/[a-z0-9][a-z0-9_-]*\/v1$/;

/** Joins an internal eve route to a public target, including compact named-agent mounts. */
export function joinEveRoutePath(basePath: string, routePath: string): string {
  const base = trimTrailingSlash(basePath);
  const route = routePath.startsWith("/") ? routePath : `/${routePath}`;
  if (route === EVE_ROUTE_PREFIX || route.startsWith(`${EVE_ROUTE_PREFIX}/`)) {
    if (EVE_NAMED_AGENT_MOUNT_PATTERN.test(base)) {
      return `${base}${route.slice("/eve".length)}`;
    }
    if (EVE_NAMED_AGENT_PROTOCOL_PATTERN.test(base)) {
      return `${base}${route.slice(EVE_ROUTE_PREFIX.length)}`;
    }
  }
  return `${base}${route}`;
}

/** Maps a compact named-agent route back to the internal eve protocol namespace. */
export function normalizePublicEveRoutePath(path: string): string {
  return path.replace(/^\/eve\/[a-z0-9][a-z0-9_-]*\/v1(?=\/|$)/, EVE_ROUTE_PREFIX);
}

function trimTrailingSlash(value: string): string {
  if (value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
