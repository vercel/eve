import { type Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveLocalBackendSessionRootPath,
  resolveLocalBackendTemplateRootPath,
  resolveLocalBackendTemplatesDirectory,
} from "#execution/sandbox/bindings/local-backend-utils.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
} from "#execution/sandbox/bindings/local-template-prune.js";
import {
  type MicrosandboxTemplateMetadata,
  readTemplateMetadata,
  resolveMicrosandboxMetadataPath,
} from "#execution/sandbox/bindings/microsandbox-metadata.js";
import {
  loadMicrosandboxWithoutInstall,
  removeSnapshotIfExists,
} from "#execution/sandbox/bindings/microsandbox-runtime.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";

const MICROSANDBOX_CACHE_DIRECTORY_NAME = "microsandbox";

/**
 * Removes stale microsandbox template metadata directories (and their
 * captured snapshots) for one application.
 */
export async function pruneMicrosandboxTemplates(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  const templatesDirectory = resolveMicrosandboxTemplatesDirectory(
    resolveSandboxCacheDirectory(input.appRoot),
  );
  const now = input.now ?? Date.now();
  const recentWindowMs = input.recentWindowMs ?? LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS;
  const retainCount = input.retainCount ?? LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT;
  const directories = await readMicrosandboxTemplateDirectories(templatesDirectory);
  const templates = directories.filter((directory) => !directory.isTemporary);

  await Promise.all([
    ...templates.map(async (template, index) => {
      if (index < retainCount || now - template.mtimeMs <= recentWindowMs) {
        return;
      }
      await removeTemplateDirectory(input.appRoot, template.path, template.metadata);
    }),
    ...directories
      .filter((directory) => directory.isTemporary)
      .map(async (directory) => {
        if (now - directory.mtimeMs <= recentWindowMs) {
          return;
        }
        await removeTemplateDirectory(input.appRoot, directory.path, directory.metadata);
      }),
  ]);
}

export function resolveMicrosandboxTemplateRootPath(
  cacheDirectory: string,
  templateKey: string,
): string {
  return resolveLocalBackendTemplateRootPath(
    cacheDirectory,
    MICROSANDBOX_CACHE_DIRECTORY_NAME,
    templateKey,
  );
}

export function resolveMicrosandboxTemplatesDirectory(cacheDirectory: string): string {
  return resolveLocalBackendTemplatesDirectory(cacheDirectory, MICROSANDBOX_CACHE_DIRECTORY_NAME);
}

export function resolveMicrosandboxSessionRootPath(
  cacheDirectory: string,
  sessionKey: string,
): string {
  return resolveLocalBackendSessionRootPath(
    cacheDirectory,
    MICROSANDBOX_CACHE_DIRECTORY_NAME,
    sessionKey,
  );
}

async function readMicrosandboxTemplateDirectories(templatesDirectory: string): Promise<
  ReadonlyArray<{
    readonly isTemporary: boolean;
    readonly metadata: MicrosandboxTemplateMetadata | null;
    readonly mtimeMs: number;
    readonly path: string;
  }>
> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(templatesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(templatesDirectory, entry.name);
          return {
            isTemporary: entry.name.endsWith(".tmp"),
            metadata: await readTemplateMetadata(resolveMicrosandboxMetadataPath(path)),
            mtimeMs: (await stat(path)).mtimeMs,
            path,
          };
        }),
    )
  ).sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function removeTemplateDirectory(
  appRoot: string,
  path: string,
  metadata: MicrosandboxTemplateMetadata | null,
): Promise<void> {
  await rm(path, { force: true, recursive: true });
  if (metadata === null) {
    return;
  }
  const module = await loadMicrosandboxWithoutInstall(appRoot);
  if (module !== null) {
    await removeSnapshotIfExists(module, metadata.snapshotName);
  }
}
