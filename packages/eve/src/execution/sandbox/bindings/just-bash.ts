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
} from "#execution/sandbox/bindings/local-backend-utils.js";
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
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
} from "#public/definitions/sandbox-backend.js";
import { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

const JUST_BASH_CACHE_DIRECTORY_NAME = "just-bash";

/**
 * Stable backend name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const JUST_BASH_BACKEND_NAME = "just-bash";

/**
 * Construction input for {@link createJustBashSandboxBackend}. Internal —
 * the public surface is the `justbash()` factory under
 * `eve/sandbox`.
 */
export interface CreateJustBashSandboxBackendInput {
  readonly createOptions?: JustBashSandboxCreateOptions;
}

/**
 * Creates the just-bash sandbox backend.
 *
 * The cache directory is derived from the runtime context's `appRoot`
 * on every `create` call so the backend stays stateless and matches
 * the framework's per-call dispatch contract.
 */
export function createJustBashSandboxBackend(
  input: CreateJustBashSandboxBackendInput = {},
): SandboxBackend {
  const autoInstall = input.createOptions?.autoInstall ?? true;
  return {
    name: JUST_BASH_BACKEND_NAME,
    async prewarm(prewarmInput: SandboxBackendPrewarmInput): Promise<SandboxBackendPrewarmResult> {
      const cacheDirectory = resolveSandboxCacheDirectory(prewarmInput.runtimeContext.appRoot);
      const templateRootPath = resolveTemplateRootPath(cacheDirectory, prewarmInput.templateKey);

      if (await pathExists(templateRootPath)) {
        await touchDirectory(templateRootPath);
        return { reused: true };
      }

      const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
      let published = false;
      const templateSandbox = await createBashSandbox({
        appRoot: prewarmInput.runtimeContext.appRoot,
        autoInstall,
        rootPath: temporaryTemplateRootPath,
        sessionKey: prewarmInput.templateKey,
      });
      const templateSession = buildSandboxSession(
        createFileBackedInternalSandboxSession({
          id: templateSandbox.sessionKey,
          sandbox: templateSandbox,
        }),
        justBashSetNetworkPolicyUnsupported,
      );

      try {
        if (prewarmInput.bootstrap !== undefined) {
          prewarmInput.log?.("running sandbox bootstrap");
          await prewarmInput.bootstrap({
            use: async () =>
              createLoggingSandboxSession({
                log: prewarmInput.log,
                session: templateSession,
              }),
          });
        }

        await writeSandboxSeedFiles(templateSession, prewarmInput.seedFiles);

        const captured = await templateSandbox.captureState();
        if (captured === null) {
          throw new Error(
            `Failed to capture local sandbox template state for "${prewarmInput.templateKey}".`,
          );
        }

        await mkdir(dirname(templateRootPath), { recursive: true });
        try {
          await rename(temporaryTemplateRootPath, templateRootPath);
          published = true;
        } catch (error) {
          if (await pathExists(templateRootPath)) {
            return { reused: true };
          }
          throw error;
        }
      } finally {
        await templateSandbox.dispose();
        if (!published) {
          await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
        }
      }

      return { reused: false };
    },
    async create(createInput: SandboxBackendCreateInput): Promise<SandboxBackendHandle> {
      const cacheDirectory = resolveSandboxCacheDirectory(createInput.runtimeContext.appRoot);
      const sessionRootPath =
        getLocalRootPath(createInput.existingMetadata) ??
        resolveSessionRootPath(cacheDirectory, createInput.sessionKey);

      if (!(await pathExists(sessionRootPath))) {
        if (createInput.templateKey === null) {
          await mkdir(sessionRootPath, { recursive: true });
        } else {
          const templateRootPath = resolveTemplateRootPath(cacheDirectory, createInput.templateKey);

          if (!(await pathExists(templateRootPath))) {
            throw new SandboxTemplateNotProvisionedError({
              backendName: JUST_BASH_BACKEND_NAME,
              templateKey: createInput.templateKey,
            });
          }

          await copyDirectoryAtomically(templateRootPath, sessionRootPath);
        }
      }

      const sandbox = await createBashSandbox({
        appRoot: createInput.runtimeContext.appRoot,
        autoInstall,
        rootPath: sessionRootPath,
        sessionKey: createInput.sessionKey,
      });

      return createJustBashHandle(sandbox, JUST_BASH_BACKEND_NAME);
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
