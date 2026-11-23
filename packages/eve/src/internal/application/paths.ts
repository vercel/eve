import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { workflowEntryReference } from "#execution/workflow-references.js";
import { platformBuild } from "#platform/build.js";
import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
  resolvePackageSourceDirectoryPath,
} from "#internal/application/package.js";

export {
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
} from "#internal/application/build-output-environment.js";

export interface ApplicationInfo {
  appRoot: string;
  outputDir: string;
  workflowId: string;
  workflowBuildDir: string;
  workflowSourceDir: string;
}

export function resolveApplicationRoot(cwd: string = process.cwd()): string {
  return resolve(cwd);
}

function getWorkflowBuildCacheKey(appRoot: string): string {
  return createHash("sha256").update(appRoot).digest("hex").slice(0, 12);
}

export function resolveWorkflowBuildDirectory(appRoot: string): string {
  const workflowCacheRoot = join(resolvePackageRoot(), ".eve", "workflow-cache");
  pruneStaleWorkflowCacheSiblings(workflowCacheRoot);
  return join(workflowCacheRoot, getWorkflowBuildCacheKey(appRoot));
}

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
    } catch {}
  }
}

export function resolveSandboxCacheDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "sandbox-cache");
}

export function resolveOutputDirectory(appRoot: string): string {
  return platformBuild().outputDirectory?.(appRoot) ?? join(appRoot, ".output");
}

export function getApplicationInfo(appRoot: string): ApplicationInfo {
  return {
    appRoot,
    outputDir: resolveOutputDirectory(appRoot),
    workflowId: workflowEntryReference.workflowId,
    workflowBuildDir: resolveWorkflowBuildDirectory(appRoot),
    workflowSourceDir: resolvePackageSourceDirectoryPath("src/execution"),
  };
}
