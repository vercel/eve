import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import type { HostRouteTable } from "#internal/nitro/host/host-routes.js";

// Named post-build shims for Vercel output. Each goes once Nitro covers it.

const SHARED_SERVER_FUNCTION = "eve/__server";

/**
 * The namespaces a service build publishes, as function directories and route
 * destinations without the leading `/`. Its output merges with the host app's,
 * so a root route such as `/` or an authored channel path could shadow the
 * host's own; those stay reachable only through the host's routing. The cron
 * route lives under eve's prefix.
 */
const SERVICE_NAMESPACES = [`${EVE_ROUTE_PREFIX.slice(1)}/`, ".well-known/workflow/"];

/**
 * Publishes a Vercel service build through one eve-owned server function.
 * Upstream ask: a configurable or `serverDir`-derived catch-all fallback.
 *
 * Nitro emits a symlinked function and a route for every handler, all aimed
 * at the root `__server.func`, plus a `/(.*)` fallback to it. The root
 * function and its fallback would collide with the host's, so the shared
 * function moves to `eve/__server.func`. A route with its own Vercel function,
 * such as a queue consumer, keeps that function, its route, and its trigger;
 * those routes are static, so the function directory is the path itself.
 * Other functions and route destinations in {@link SERVICE_NAMESPACES} are
 * served by the shared function; everything else is pruned.
 */
export async function normalizeVercelServiceOutput(
  outputDir: string,
  routeTable: Pick<HostRouteTable, "routes">,
): Promise<void> {
  const ownFunctions = new Set(
    routeTable.routes.flatMap((route) => ("vercelFunction" in route ? [route.path.slice(1)] : [])),
  );
  const isShared = (functionPath: string) =>
    SERVICE_NAMESPACES.some((namespace) => functionPath.startsWith(namespace));

  const functionsDir = join(outputDir, "functions");
  const sharedFunctionDir = join(functionsDir, `${SHARED_SERVER_FUNCTION}.func`);
  await copyDirectory(await realpath(join(functionsDir, "__server.func")), sharedFunctionDir);
  for (const { path, functionPath } of await listFunctions(functionsDir)) {
    if (functionPath === SHARED_SERVER_FUNCTION || ownFunctions.has(functionPath)) continue;
    await rm(path, { force: true, recursive: true });
    if (isShared(functionPath)) {
      await symlink(toPosix(relative(dirname(path), sharedFunctionDir)), path, "dir");
    }
  }

  const configPath = join(outputDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { routes: VercelRoute[] };
  config.routes = config.routes.flatMap((route): VercelRoute[] => {
    if (route.dest === undefined) return [route];
    const functionPath = route.dest.slice(1);
    if (ownFunctions.has(functionPath)) return [route];
    return isShared(functionPath) ? [{ ...route, dest: `/${SHARED_SERVER_FUNCTION}` }] : [];
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

interface VercelRoute {
  readonly dest?: string;
  readonly [key: string]: unknown;
}

/** Every `.func` entry under `functionsDir`, without descending into one. */
async function listFunctions(
  functionsDir: string,
): Promise<{ readonly path: string; readonly functionPath: string }[]> {
  const found: { path: string; functionPath: string }[] = [];
  const walk = async (directory: string) => {
    const entries: Dirent<string>[] = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name.endsWith(".func")) {
        found.push({ path, functionPath: toPosix(relative(functionsDir, path)).slice(0, -5) });
      } else if (entry.isDirectory()) {
        await walk(path);
      }
    }
  };
  await walk(functionsDir);
  return found;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  const staging = `${destination}.eve-staging`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(staging, { force: true, recursive: true });
  await cp(source, staging, { dereference: true, recursive: true });
  await rm(destination, { force: true, recursive: true });
  await rename(staging, destination);
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}
