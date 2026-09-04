/** Preserve Nitro's method precedence before trying the GET route for HEAD. */
export function findRouteWithHeadFallback<T>(
  findRoute: (method: string, pathname: string) => T | undefined,
  method: string,
  pathname: string,
): T | undefined {
  const matched = findRoute(method, pathname);
  return matched ?? (method === "HEAD" ? findRoute("GET", pathname) : undefined);
}
