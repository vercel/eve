/** Joins an eve route to a remote agent base URL without dropping its path prefix. */
export function createRemoteAgentRouteUrl(baseUrl: string, routePath: string): string {
  return new URL(routePath.replace(/^\/+/, ""), `${trimTrailingSlash(baseUrl)}/`).toString();
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
