import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const EVE_SHARED_SERVER_FUNCTION_PATH = "eve/__server.func";

const EVE_SHARED_SERVER_ROUTE_DESTINATION = "/eve/__server";
const EVE_SERVICE_ROUTE_PREFIX_WRAPPER = "index.__eve_service_route_prefix.mjs";
const EVE_VERCEL_FUNCTION_PREFIXES = ["eve/", ".well-known/workflow/"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isEveVercelFunctionPath(path: string): boolean {
  return EVE_VERCEL_FUNCTION_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function normalizeEveVercelRoutes(
  routes: readonly unknown[],
  servicePrefix: string | undefined,
): unknown[] {
  return routes
    .filter(isEveVercelRoute)
    .map((route) => normalizeEveVercelRoute(route, servicePrefix));
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

function normalizeEveVercelRoute(route: unknown, servicePrefix: string | undefined): unknown {
  if (!isRecord(route) || "handle" in route || typeof route.src !== "string") {
    return route;
  }

  const shouldUseSharedServerFunction =
    isEveProtocolRoutePath(route.src) ||
    (typeof route.dest === "string" && isEveProtocolRoutePath(route.dest));
  const nextRoute: Record<string, unknown> = {
    ...route,
    src: prefixEveVercelRoutePath(route.src, servicePrefix),
  };

  if (shouldUseSharedServerFunction) {
    nextRoute.dest = EVE_SHARED_SERVER_ROUTE_DESTINATION;
  }

  return nextRoute;
}

function prefixEveVercelRoutePath(path: string, servicePrefix: string | undefined): string {
  if (
    servicePrefix === undefined ||
    servicePrefix === "/" ||
    !isEveVercelRoutePath(path) ||
    path.includes(servicePrefix)
  ) {
    return path;
  }

  const normalizedPrefix = servicePrefix.endsWith("/") ? servicePrefix.slice(0, -1) : servicePrefix;
  const escapedPrefix = normalizedPrefix.replaceAll("/", "\\/");

  if (path.includes(escapedPrefix)) {
    return path;
  }

  if (path.startsWith("^(?:/")) {
    return `^(?:${normalizedPrefix}${path.slice(4)}`;
  }

  if (path.startsWith("^/")) {
    return `^${normalizedPrefix}${path.slice(1)}`;
  }

  if (path.startsWith("/")) {
    return `${normalizedPrefix}${path}`;
  }

  return path;
}

export async function applyEveServiceRoutePrefixWrapper(
  functionPath: string,
  servicePrefix: string,
): Promise<void> {
  const configPath = join(functionPath, ".vc-config.json");
  const wrapperPath = join(functionPath, EVE_SERVICE_ROUTE_PREFIX_WRAPPER);
  const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const config = isRecord(rawConfig) ? rawConfig : {};

  await writeFile(wrapperPath, createEveServiceRoutePrefixWrapper(servicePrefix));
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        handler: EVE_SERVICE_ROUTE_PREFIX_WRAPPER,
      },
      null,
      2,
    )}\n`,
  );
}

function createEveServiceRoutePrefixWrapper(servicePrefix: string): string {
  return `
import { Server } from "node:http";

const SERVICE_PREFIX = ${JSON.stringify(normalizeServiceRoutePrefix(servicePrefix))};
const PATCH_SYMBOL = Symbol.for("eve.service.route-prefix-strip.patch");

function stripServiceRoutePrefix(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl === "*") {
    return requestUrl;
  }

  const queryIndex = requestUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : requestUrl.slice(queryIndex);
  const path = rawPath.startsWith("/") ? rawPath : \`/\${rawPath}\`;

  if (path === SERVICE_PREFIX) {
    return \`/\${query}\`;
  }

  if (path.startsWith(\`\${SERVICE_PREFIX}/\`)) {
    return path.slice(SERVICE_PREFIX.length) + query;
  }

  return path + query;
}

if (!globalThis[PATCH_SYMBOL]) {
  globalThis[PATCH_SYMBOL] = true;
  const originalEmit = Server.prototype.emit;
  Server.prototype.emit = function patchedEmit(event, request, ...args) {
    if ((event === "request" || event === "upgrade") && request && typeof request.url === "string") {
      request.url = stripServiceRoutePrefix(request.url);
    }

    return originalEmit.call(this, event, request, ...args);
  };
}

const originalModule = await import("./index.mjs");
const entrypoint = originalModule?.default ?? originalModule;

export const handleUpgrade = originalModule.handleUpgrade
  ? (request, socket, head) => {
      if (request && typeof request.url === "string") {
        request.url = stripServiceRoutePrefix(request.url);
      }

      return originalModule.handleUpgrade(request, socket, head);
    }
  : undefined;

export default entrypoint;
`.trimStart();
}

function normalizeServiceRoutePrefix(servicePrefix: string): string {
  const prefixed = servicePrefix.startsWith("/") ? servicePrefix : `/${servicePrefix}`;
  const normalized = prefixed.replace(/\/+$/, "");

  return normalized.length === 0 ? "/" : normalized;
}
