export const EVE_SHARED_SERVER_FUNCTION_PATH = "eve/__server.func";

const EVE_SHARED_SERVER_ROUTE_DESTINATION = "/eve/__server";
const EVE_VERCEL_FUNCTION_PREFIXES = ["eve/", ".well-known/workflow/"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isEveVercelFunctionPath(path: string): boolean {
  return EVE_VERCEL_FUNCTION_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function normalizeEveVercelRoutes(
  routes: readonly unknown[],
  _servicePrefix: string | undefined,
): unknown[] {
  return routes.filter(isEveVercelRoute).map(normalizeEveVercelRoute);
}

function isEveVercelRoute(route: unknown): boolean {
  if (!isRecord(route)) {
    return true;
  }

  if ("handle" in route) {
    return true;
  }

  const src = typeof route.src === "string" ? route.src : "";
  const dest = typeof route.dest === "string" ? route.dest : "";

  return isEveVercelRoutePath(src) || isEveVercelRoutePath(dest);
}

function isEveVercelRoutePath(path: string): boolean {
  return path.includes("/eve/v1") || path.includes("/.well-known/workflow/");
}

function isEveProtocolRoutePath(path: string): boolean {
  return path.includes("/eve/v1");
}

function normalizeEveVercelRoute(route: unknown): unknown {
  if (!isRecord(route) || "handle" in route || typeof route.src !== "string") {
    return route;
  }

  const shouldUseSharedServerFunction =
    isEveProtocolRoutePath(route.src) ||
    (typeof route.dest === "string" && isEveProtocolRoutePath(route.dest));
  const nextRoute: Record<string, unknown> = {
    ...route,
  };

  if (shouldUseSharedServerFunction) {
    nextRoute.dest = EVE_SHARED_SERVER_ROUTE_DESTINATION;
  }

  return nextRoute;
}
