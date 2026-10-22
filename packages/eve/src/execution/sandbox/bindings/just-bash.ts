import { randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  copyDirectoryAtomically,
  pathExists,
  resolveLocalProviderSessionRootPath,
  resolveLocalProviderTemplateRootPath,
  resolveLocalProviderTemplatesDirectory,
  touchDirectory,
} from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  createBashSandbox,
  importJustBashModule,
  installJustBashModule,
} from "#execution/sandbox/bindings/just-bash-runtime.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  selectStaleTemplateEntries,
} from "#execution/sandbox/bindings/local-template-prune.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import {
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
  type SandboxJson,
  type SandboxProviderImplementation,
  type SandboxSessionContext,
} from "#public/sandbox/provider.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { isObject } from "#shared/guards.js";
import {
  invalidPreparedSandboxArtifactError,
  invalidSandboxSessionStateError,
} from "#shared/sandbox-recorded-data-error.js";

const JUST_BASH_CACHE_DIRECTORY_NAME = "just-bash";
export const JUST_BASH_PROVIDER_NAME = "just-bash";

// Holds the template key, not its path: the build and runtime app roots can differ.
type JustBashPreparedArtifact = { readonly templateKey: string };
type JustBashSessionState = { readonly rootPath: string; readonly version: 2 };

export function createJustBashSandboxProvider(
  options: JustBashSandboxCreateOptions = {},
): SandboxProviderImplementation<undefined, JustBashPreparedArtifact, JustBashSessionState, {}> {
  const autoInstall = options.autoInstall ?? true;

  async function connect(context: SandboxSessionContext, rootPath: string) {
    return await createBashSandbox({
      customCommands: options.customCommands,
      filesystem: options.filesystem,
      justBash: await importJustBashModule(context.resolveProjectPath(".")),
      resolveProjectPath: (path) => context.resolveProjectPath(path),
      rootPath,
      storagePath: context.storagePath,
    });
  }

  return {
    async onSessionEnd(context, state) {
      await rm(state?.rootPath ?? sessionRootPath(context), { force: true, recursive: true });
    },
    async prepare(context) {
      // Custom commands and the filesystem apply only to live sessions, so they stay out of the key.
      const templateKey = context.templateKey({ version: 2 }).slice(0, 24);
      const templateRootPath = resolveTemplateRootPath(context.storagePath, templateKey);
      if (await pathExists(templateRootPath)) {
        await touchDirectory(templateRootPath);
        context.log("reusing cached template filesystem");
        return { templateKey };
      }

      const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
      let published = false;
      const templateSandbox = await createBashSandbox({
        justBash: await installJustBashModule({
          appRoot: context.resolveProjectPath("."),
          autoInstall,
        }),
        resolveProjectPath: (path) => context.resolveProjectPath(path),
        rootPath: temporaryTemplateRootPath,
        storagePath: context.storagePath,
      });

      try {
        await context.populate(templateSandbox);
        await templateSandbox.captureState();
        await mkdir(dirname(templateRootPath), { recursive: true });
        try {
          await rename(temporaryTemplateRootPath, templateRootPath);
          published = true;
        } catch (error) {
          if (await pathExists(templateRootPath)) return { templateKey };
          throw error;
        }
      } finally {
        await templateSandbox.stop();
        if (!published) await rm(temporaryTemplateRootPath, { force: true, recursive: true });
      }
      return { templateKey };
    },
    async resume(context, _artifact, stateValue) {
      const { rootPath } = requireJustBashSessionState(stateValue);
      if (!(await pathExists(rootPath))) {
        throw new SandboxSessionGoneError(`just-bash session root "${rootPath}" no longer exists.`);
      }
      return await connect(context, rootPath);
    },
    async start(context, _openOptions, artifactValue) {
      const artifact = requirePreparedJustBashArtifact(artifactValue);
      const rootPath = sessionRootPath(context);
      await ensureSessionRoot(
        resolveTemplateRootPath(context.storagePath, artifact.templateKey),
        rootPath,
      );
      return { connection: await connect(context, rootPath), state: { rootPath, version: 2 } };
    },
    // eve never ends a keyed sandbox; just-bash keeps it only as files on the local disk.
    toolSessions: true,
  };
}

/**
 * The session's root, under the app's storage path. The template applies
 * only when the root is created, so a session keeps its files across rebuilds.
 */
function sessionRootPath(context: SandboxSessionContext): string {
  return resolveSessionRootPath(
    context.storagePath,
    createSandboxProviderIdentity({ sessionId: context.session.id, version: 2 }).slice(0, 24),
  );
}

async function ensureSessionRoot(templateRootPath: string, sessionRootPath: string): Promise<void> {
  if (await pathExists(sessionRootPath)) return;
  if (!(await pathExists(templateRootPath))) {
    throw new SandboxTemplateNotProvisionedError({
      providerName: JUST_BASH_PROVIDER_NAME,
      reason:
        "The template directory does not exist: it was deleted, or the build ran on another machine.",
      templateKey: templateRootPath,
    });
  }
  await copyDirectoryAtomically(templateRootPath, sessionRootPath);
}

export async function pruneJustBashSandboxTemplates(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  const templatesDirectory = resolveLocalProviderTemplatesDirectory(
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
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

function requirePreparedJustBashArtifact(artifact: SandboxJson): JustBashPreparedArtifact {
  if (!isObject(artifact) || typeof artifact.templateKey !== "string") {
    throw invalidPreparedSandboxArtifactError("just-bash sandbox");
  }
  return { templateKey: artifact.templateKey };
}

function requireJustBashSessionState(state: SandboxJson): JustBashSessionState {
  if (!isObject(state) || state.version !== 2 || typeof state.rootPath !== "string") {
    throw invalidSandboxSessionStateError("just-bash sandbox");
  }
  return { rootPath: state.rootPath, version: 2 };
}

function resolveTemplateRootPath(storagePath: string, key: string): string {
  return resolveLocalProviderTemplateRootPath(storagePath, JUST_BASH_CACHE_DIRECTORY_NAME, key);
}

function resolveSessionRootPath(storagePath: string, key: string): string {
  return resolveLocalProviderSessionRootPath(storagePath, JUST_BASH_CACHE_DIRECTORY_NAME, key);
}
