import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { workflowEntryReference } from "#execution/workflow-runtime.js";
import type { NitroBuildSurface } from "#internal/nitro/host/types.js";
import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
  resolvePackageSourceDirectoryPath,
} from "#internal/application/package.js";

export interface ApplicationInfo {
  appRoot: string;
  outputDir: string;
  workflowId: string;
  workflowBuildDir: string;
  workflowSourceDir: string;
}

/**
 * Resolves an application root from the current working directory.
 */
export function resolveApplicationRoot(cwd: string = process.cwd()): string {
  return resolve(cwd);
}

function getWorkflowBuildCacheKey(appRoot: string): string {
  return createHash("sha256").update(appRoot).digest("hex").slice(0, 12);
}

function isVercelBuildEnvironment(): boolean {
  return Boolean(process.env.VERCEL);
}

/**
 * Resolves the programmatic Nitro build directory for an app.
 */
export function resolveNitroBuildDirectory(
  appRoot: string,
  surface: NitroBuildSurface = "all",
): string {
  const rootDirectory = join(appRoot, ".eve", "nitro");

  if (surface === "all") {
    return rootDirectory;
  }

  return join(rootDirectory, surface);
}

/**
 * Resolves the staged Nitro output directory for one isolated build surface.
 */
export function resolveNitroSurfaceOutputDirectory(
  appRoot: string,
  surface: Exclude<NitroBuildSurface, "all">,
): string {
  return join(appRoot, ".eve", "nitro-output", surface);
}

/**
 * Resolves the package-owned Workflow DevKit bundle directory for a target app.
 *
 * This directory is intentionally placed under the package root rather than the
 * application root so package-owned workflow caches are shared across generated
 * app roots without relying on app-local installed dependencies.
 *
 * Each application root receives a unique hash-keyed subdirectory so parallel
 * builds targeting different app roots never collide. The key is derived from
 * `appRoot` alone — version-keyed dirs are intentionally avoided so every code
 * path that resolves a cache directory converges on the same location and
 * `prepareEveVersionedCacheDirectory` remains the single source of truth for
 * version-based invalidation.
 */
export function resolveWorkflowBuildDirectory(appRoot: string): string {
  const workflowCacheRoot = join(resolvePackageRoot(), ".eve", "workflow-cache");
  pruneStaleWorkflowCacheSiblings(workflowCacheRoot);
  return join(workflowCacheRoot, getWorkflowBuildCacheKey(appRoot));
}

/*
 * Defensive cleanup: removes legacy sibling cache directories whose recorded
 * eveVersion does not match the currently installed eve. Earlier versions
 * keyed the cache directory by `appRoot + workflowId` (which embedded the
 * eve version), so an upgrade left one or more orphaned directories on
 * disk. Without this sweep those directories can still be picked up by
 * downstream build steps and bake stale step IDs (e.g.
 * `step//eve@0.18.3//...`) into a freshly built dev bundle.
 */
function pruneStaleWorkflowCacheSiblings(workflowCacheRoot: string): void {
  if (!existsSync(workflowCacheRoot)) {
    return;
  }
  const currentVersion = resolveInstalledPackageInfo().version;
  let entries: string[];
  try {
    entries = readdirSync(workflowCacheRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(workflowCacheRoot, entry);
    const metadataPath = join(entryPath, "eve-cache.json");
    if (!existsSync(metadataPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as { eveVersion?: unknown };
      if (typeof parsed.eveVersion === "string" && parsed.eveVersion !== currentVersion) {
        rmSync(entryPath, { force: true, recursive: true });
      }
    } catch {
      // Best-effort cleanup; ignore corrupt metadata.
    }
  }
}

/**
 * Resolves the cache directory used for durable local sandbox snapshots.
 */
export function resolveSandboxCacheDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "sandbox-cache");
}

/**
 * Resolves the production Nitro output directory for an app.
 */
export function resolveOutputDirectory(appRoot: string): string {
  if (isVercelBuildEnvironment()) {
    return join(appRoot, ".vercel", "output");
  }

  return join(appRoot, ".output");
}

/**
 * Returns structured app information for diagnostics and CLI output.
 */
export function getApplicationInfo(appRoot: string): ApplicationInfo {
  return {
    appRoot,
    outputDir: resolveOutputDirectory(appRoot),
    workflowId: workflowEntryReference.workflowId,
    workflowBuildDir: resolveWorkflowBuildDirectory(appRoot),
    workflowSourceDir: resolvePackageSourceDirectoryPath("src/execution"),
  };
}
