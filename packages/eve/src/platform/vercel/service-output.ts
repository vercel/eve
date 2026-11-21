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
import { VERCEL_SCHEDULES_FUNCTION_ROUTE } from "#platform/vercel/build-output-config.js";

const SHARED_SERVER_FUNCTION = "eve/__server";

const SERVICE_NAMESPACES = [`${EVE_ROUTE_PREFIX.slice(1)}/`, ".well-known/workflow/"];

export async function normalizeVercelServiceOutput(
  outputDir: string,
  routeTable: Pick<HostRouteTable, "routes">,
): Promise<void> {
  const ownFunctions = new Set([
    ...routeTable.routes.flatMap((route) =>
      "vercelFunction" in route ? [route.path.slice(1)] : [],
    ),
    VERCEL_SCHEDULES_FUNCTION_ROUTE.slice(1),
  ]);
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
