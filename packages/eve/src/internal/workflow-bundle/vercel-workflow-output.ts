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

import {
  EVE_SHARED_SERVER_FUNCTION_PATH,
  isEveVercelFunctionPath,
  normalizeEveVercelRoutes,
} from "#internal/workflow-bundle/eve-service-route-output.js";

// just-bash and microsandbox are optional peer dependencies (the
// opt-in local sandbox engines) loaded lazily from the application's
// install; just-bash additionally exposes native optional codecs for
// xz/zstd support. All of these must stay external so workflow step
// bundles neither fail resolving an absent optional install nor try to
// inline platform-specific `.node` artifacts.
export const WORKFLOW_STEP_EXTERNAL_PACKAGES = [
  "@mongodb-js/zstd",
  "just-bash",
  "microsandbox",
  "node-liblzma",
] as const;

/**
 * Packages that must stay external during the initial workflow builder
 * pass so `node:*` transitive dependencies do not fail the workflow VM check.
 * Nitro performs the final bundling/tracing pass for hosted output.
 */
export const WORKFLOW_BUILDER_DEFERRED_PACKAGES = ["@chat-adapter/slack", "chat"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keeps only eve-owned Vercel function output and rewrites eve route function
 * symlinks to a shared eve-owned server function.
 *
 * Nitro emits generic app routes such as `index.func -> ./__server.func` for
 * eve's standalone landing page. In a multi-service Next.js deployment those
 * root aliases collide with Next's own functions. The Next integration only
 * proxies eve's `/eve/v1/**` transport routes, so Vercel output should expose
 * those route functions and workflow trigger functions, not eve's root page.
 *
 * Nitro also dedupes every route function through `__server.func`. Preserve
 * that model by copying the shared target once into the eve-owned tree and
 * repointing eve route aliases at it before pruning the root target.
 */
export async function normalizeEveVercelFunctionOutput(
  outputDir: string,
  options: { readonly servicePrefix?: string } = {},
): Promise<void> {
  const functionsDir = join(outputDir, "functions");
  const sharedFunctionPath = await prepareSharedEveServerFunction(functionsDir);

  if (sharedFunctionPath !== null) {
    await repointEveFunctionSymlinksInDirectory(functionsDir, sharedFunctionPath);
  }
  await pruneNonEveFunctionEntries(functionsDir, functionsDir);
  await pruneNonEveVercelRoutes(outputDir, options.servicePrefix);
}

async function prepareSharedEveServerFunction(functionsDir: string): Promise<string | null> {
  const rootServerFunctionPath = join(functionsDir, "__server.func");
  const sharedFunctionPath = join(functionsDir, EVE_SHARED_SERVER_FUNCTION_PATH);
  let sourcePath: string;

  try {
    sourcePath = await realpath(rootServerFunctionPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const stagingPath = `${sharedFunctionPath}.eve-staging`;

  await mkdir(dirname(sharedFunctionPath), {
    recursive: true,
  });
  await rm(stagingPath, {
    force: true,
    recursive: true,
  });
  await cp(sourcePath, stagingPath, {
    dereference: true,
    recursive: true,
  });
  await rm(sharedFunctionPath, {
    force: true,
    recursive: true,
  });
  await rename(stagingPath, sharedFunctionPath);

  return sharedFunctionPath;
}

async function repointEveFunctionSymlinksInDirectory(
  directoryPath: string,
  sharedFunctionPath: string,
  functionsDir: string = directoryPath,
): Promise<void> {
  let entries: Dirent<string>[];

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directoryPath, entry.name);
      const relativeFunctionPath = normalizeVercelOutputPath(relative(functionsDir, entryPath));

      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith(".func") && isEveVercelFunctionPath(relativeFunctionPath)) {
          await repointFunctionSymlink(entryPath, sharedFunctionPath);
        }
        return;
      }

      if (entry.isDirectory() && !entry.name.endsWith(".func")) {
        await repointEveFunctionSymlinksInDirectory(entryPath, sharedFunctionPath, functionsDir);
      }
    }),
  );
}

async function repointFunctionSymlink(
  functionPath: string,
  sharedFunctionPath: string,
): Promise<void> {
  await rm(functionPath, {
    force: true,
    recursive: true,
  });
  await symlink(
    normalizeVercelOutputPath(relative(dirname(functionPath), sharedFunctionPath)),
    functionPath,
    "dir",
  );
}

async function pruneNonEveFunctionEntries(
  functionsDir: string,
  directoryPath: string,
): Promise<void> {
  let entries: Dirent<string>[];

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directoryPath, entry.name);
      const relativeFunctionPath = normalizeVercelOutputPath(relative(functionsDir, entryPath));

      if (entry.name.endsWith(".func")) {
        if (!isEveVercelFunctionPath(relativeFunctionPath)) {
          await rm(entryPath, {
            force: true,
            recursive: true,
          });
        }
        return;
      }

      if (entry.isDirectory()) {
        await pruneNonEveFunctionEntries(functionsDir, entryPath);
      }
    }),
  );
}

async function pruneNonEveVercelRoutes(
  outputDir: string,
  servicePrefix: string | undefined,
): Promise<void> {
  const configPath = join(outputDir, "config.json");
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.routes)) {
    return;
  }

  parsed.routes = normalizeEveVercelRoutes(parsed.routes, servicePrefix);
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function normalizeVercelOutputPath(path: string): string {
  return path.replaceAll("\\", "/");
}
