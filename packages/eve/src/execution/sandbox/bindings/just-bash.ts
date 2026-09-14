import { randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  copyDirectoryAtomically,
  createFileBackedInternalSandboxSession,
  pathExists,
  resolveLocalBackendSessionRootPath,
  resolveLocalBackendTemplateRootPath,
  resolveLocalBackendTemplatesDirectory,
  touchDirectory,
  writeSandboxSeedFiles,
} from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  createBashSandbox,
  createJustBashHandle,
  justBashSetNetworkPolicyUnsupported,
} from "#execution/sandbox/bindings/just-bash-runtime.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  selectStaleTemplateEntries,
} from "#execution/sandbox/bindings/local-template-prune.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import {
  isSandboxPreparedArtifactRecord,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
  type SandboxProviderResources,
} from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

const JUST_BASH_CACHE_DIRECTORY_NAME = "just-bash";

/**
 * Stable backend name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const JUST_BASH_PROVIDER_NAME = "just-bash";

/**
 * Creates the just-bash sandbox provider.
 *
 * The cache directory is derived from the runtime context's `appRoot`
 * on every `create` call so the backend stays stateless and matches
 * the framework's per-call dispatch contract.
 */
export function createJustBashSandboxProvider(
  options: JustBashSandboxCreateOptions = {},
): SandboxProviderImplementation<undefined, Record<string, unknown>> {
  const autoInstall = options.autoInstall ?? true;
  const customCommands = options.customCommands;
  const filesystem = options.filesystem;
  return {
    async prepare(context) {
      const cacheDirectory = resolveSandboxCacheDirectory(context.appRoot);
      const templateRootPath = resolveTemplateRootPath(cacheDirectory, context.templateName);

      if (await pathExists(templateRootPath)) {
        await touchDirectory(templateRootPath);
        return { artifact: { templateRootPath }, reused: true };
      }

      const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
      let published = false;
      const templateSandbox = await createBashSandbox({
        appRoot: context.appRoot,
        autoInstall,
        rootPath: temporaryTemplateRootPath,
        sessionKey: context.templateName,
      });
      const templateSession = buildSandboxSession(
        createFileBackedInternalSandboxSession({
          id: templateSandbox.sessionKey,
          sandbox: templateSandbox,
        }),
        justBashSetNetworkPolicyUnsupported,
      );

      try {
        await writeSandboxSeedFiles(templateSession, providerSeedFiles(context.resources));
        context.log?.("running sandbox preparation");
        await context.runPreparation(
          createLoggingSandboxSession({ log: context.log, session: templateSession }),
        );

        const captured = await templateSandbox.captureState();
        if (captured === null) {
          throw new Error(
            `Failed to capture local sandbox template state for "${context.templateName}".`,
          );
        }

        await mkdir(dirname(templateRootPath), { recursive: true });
        try {
          await rename(temporaryTemplateRootPath, templateRootPath);
          published = true;
        } catch (error) {
          if (await pathExists(templateRootPath)) {
            return { artifact: { templateRootPath }, reused: true };
          }
          throw error;
        }
      } finally {
        await templateSandbox.dispose();
        if (!published) {
          await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
        }
      }

      return { artifact: { templateRootPath }, reused: false };
    },
    async getOrCreate(context, prepared) {
      const cacheDirectory = resolveSandboxCacheDirectory(context.appRoot);
      const sessionRootPath =
        getLocalRootPath(context.existing) ??
        resolveSessionRootPath(cacheDirectory, context.sandboxName);

      if (!(await pathExists(sessionRootPath))) {
        if (prepared === undefined) {
          await mkdir(sessionRootPath, { recursive: true });
        } else {
          const templateRootPath = readPreparedTemplateRootPath(prepared.artifact);
          if (templateRootPath === undefined || !(await pathExists(templateRootPath))) {
            throw new SandboxTemplateNotProvisionedError({
              providerName: JUST_BASH_PROVIDER_NAME,
              templateKey: prepared.templateName,
            });
          }

          await copyDirectoryAtomically(templateRootPath, sessionRootPath);
        }
      }

      const sandbox = await createBashSandbox({
        appRoot: context.appRoot,
        autoInstall,
        customCommands,
        filesystem,
        rootPath: sessionRootPath,
        sessionKey: context.sandboxName,
      });

      return context.handle(createJustBashHandle(sandbox));
    },
  };
}

/**
 * Removes stale just-bash sandbox template directories for one
 * application's cache.
 */
export async function pruneJustBashSandboxTemplates(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  const templatesDirectory = resolveLocalBackendTemplatesDirectory(
    resolveSandboxCacheDirectory(input.appRoot),
    JUST_BASH_CACHE_DIRECTORY_NAME,
  );
  const now = input.now ?? Date.now();
  const recentWindowMs = input.recentWindowMs ?? LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS;
  const retainCount = input.retainCount ?? LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT;

  let entries: Dirent<string>[];
  try {
    entries = await readdir(templatesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(templatesDirectory, entry.name);
        return {
          isTemporary: entry.name.endsWith(".tmp"),
          mtimeMs: (await stat(path)).mtimeMs,
          path,
        };
      }),
  );

  const staleTemplates = selectStaleTemplateEntries(
    directories.filter((directory) => !directory.isTemporary),
    { now, recentWindowMs, retainCount },
  );
  // Temporary build directories are garbage as soon as they fall out of
  // the recency window — they only exist while a publish is in flight.
  const staleTemporaries = selectStaleTemplateEntries(
    directories.filter((directory) => directory.isTemporary),
    { now, recentWindowMs, retainCount: 0 },
  );

  await Promise.all(
    [...staleTemplates, ...staleTemporaries].map(
      async (entry) => await rm(entry.path, { force: true, recursive: true }),
    ),
  );
}

function readPreparedTemplateRootPath(artifact: SandboxPreparedArtifact): string | undefined {
  if (!isSandboxPreparedArtifactRecord(artifact)) return undefined;
  return typeof artifact.templateRootPath === "string" ? artifact.templateRootPath : undefined;
}

function providerSeedFiles(resources: SandboxProviderResources) {
  return [
    ...(resources.workspace?.files.map((file) => ({
      content: file.content,
      path: `${resources.workspace?.targetPath}/${file.relativePath}`,
    })) ?? []),
    ...(resources.skills?.files.map((file) => ({
      content: file.content,
      path: `${resources.skills?.targetPath}/${file.relativePath}`,
    })) ?? []),
  ];
}

function resolveTemplateRootPath(cacheDirectory: string, templateKey: string): string {
  return resolveLocalBackendTemplateRootPath(
    cacheDirectory,
    JUST_BASH_CACHE_DIRECTORY_NAME,
    templateKey,
  );
}

function resolveSessionRootPath(cacheDirectory: string, sessionKey: string): string {
  return resolveLocalBackendSessionRootPath(
    cacheDirectory,
    JUST_BASH_CACHE_DIRECTORY_NAME,
    sessionKey,
  );
}

function getLocalRootPath(metadata: Record<string, unknown> | undefined): string | undefined {
  const rootPath = metadata?.rootPath;
  return typeof rootPath === "string" ? rootPath : undefined;
}
