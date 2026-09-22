import { randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  copyDirectoryAtomically,
  createFileBackedInternalSandboxSession,
  pathExists,
  resolveLocalProviderSessionRootPath,
  resolveLocalProviderTemplateRootPath,
  resolveLocalProviderTemplatesDirectory,
  touchDirectory,
  writeSandboxSeedFiles,
} from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  createBashSandbox,
  createJustBashHandle,
} from "#execution/sandbox/bindings/just-bash-runtime.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  selectStaleTemplateEntries,
} from "#execution/sandbox/bindings/local-template-prune.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type { FixedNetworkSandboxSession } from "#shared/sandbox-session.js";
import {
  isSandboxPreparedArtifactRecord,
  providerResourceTargetFiles,
  sandboxProviderResourceIdentity,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";

const JUST_BASH_CACHE_DIRECTORY_NAME = "just-bash";
export const JUST_BASH_PROVIDER_NAME = "just-bash";

type JustBashPreparedArtifact = { readonly templateRootPath: string };
type JustBashSessionState = {
  readonly generation: string;
  readonly rootPath: string;
  readonly version: 2;
};

export function createJustBashSandboxProvider(
  authoredOptions: JustBashSandboxCreateOptions | undefined = undefined,
): SandboxProviderImplementation<
  undefined,
  JustBashPreparedArtifact,
  JustBashSessionState,
  FixedNetworkSandboxSession
> {
  const options = authoredOptions ?? {};
  const autoInstall = options.autoInstall ?? true;
  const environmentIdentity = {
    autoInstall,
    customCommands: options.customCommands,
    filesystem: options.filesystem,
    version: 2,
  };

  return {
    async prepare(context) {
      const templateIdentity = createSandboxProviderIdentity({
        ...environmentIdentity,
        resources: sandboxProviderResourceIdentity(context.resources),
        sourceRevision: context.sourceRevision,
      }).slice(0, 24);
      const templateRootPath = resolveTemplateRootPath(context.storagePath, templateIdentity);
      if (await pathExists(templateRootPath)) {
        await touchDirectory(templateRootPath);
        context.log?.("reusing cached template filesystem");
        return { templateRootPath };
      }

      const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
      let published = false;
      const templateSandbox = await createBashSandbox({
        autoInstall,
        host: context.host,
        rootPath: temporaryTemplateRootPath,
        sessionKey: `prepare-${templateIdentity}`,
        storagePath: context.storagePath,
      });
      const templateSession = buildSandboxSession(
        createFileBackedInternalSandboxSession({ sandbox: templateSandbox }),
      );

      try {
        await writeSandboxSeedFiles(
          templateSession,
          providerResourceTargetFiles(context.resources),
        );
        if (options.prepare !== undefined) {
          context.log?.("running sandbox preparation");
          await options.prepare(
            createLoggingSandboxSession({ log: context.log, session: templateSession }),
          );
        }
        await templateSandbox.captureState();
        await mkdir(dirname(templateRootPath), { recursive: true });
        try {
          await rename(temporaryTemplateRootPath, templateRootPath);
          published = true;
        } catch (error) {
          if (await pathExists(templateRootPath)) return { templateRootPath };
          throw error;
        }
      } finally {
        await templateSandbox.dispose();
        if (!published) await rm(temporaryTemplateRootPath, { force: true, recursive: true });
      }
      return { templateRootPath };
    },
    async resume(context, artifactValue, stateValue) {
      const artifact = requirePreparedJustBashArtifact(artifactValue);
      const state = requireJustBashSessionState(stateValue);
      const generation = createSandboxProviderIdentity({ artifact, version: 1 });
      const expectedRootPath = sessionRootPath(context, artifact);
      if (state.generation !== generation || state.rootPath !== expectedRootPath) {
        throw new Error("just-bash session state is incompatible with this environment.");
      }
      if (!(await pathExists(state.rootPath))) {
        throw new Error(`just-bash session root "${state.rootPath}" no longer exists.`);
      }
      return await openHandle(context, state.rootPath, options);
    },
    async start(context, _openOptions, artifactValue) {
      const artifact = requirePreparedJustBashArtifact(artifactValue);
      const rootPath = sessionRootPath(context, artifact);
      await ensureSessionRoot(artifact, rootPath);
      return {
        handle: await openHandle(context, rootPath, options),
        state: {
          generation: createSandboxProviderIdentity({ artifact, version: 1 }),
          rootPath,
          version: 2,
        },
      };
    },
  };
}

function sessionRootPath(
  context: SandboxProviderSessionContext,
  artifact: JustBashPreparedArtifact,
): string {
  return resolveSessionRootPath(
    context.storagePath,
    createSandboxProviderIdentity({ artifact, sessionId: context.session.id, version: 1 }).slice(
      0,
      24,
    ),
  );
}

async function ensureSessionRoot(
  artifact: JustBashPreparedArtifact,
  sessionRootPath: string,
): Promise<void> {
  if (await pathExists(sessionRootPath)) return;
  if (!(await pathExists(artifact.templateRootPath))) {
    throw new SandboxTemplateNotProvisionedError({
      providerName: JUST_BASH_PROVIDER_NAME,
      templateKey: artifact.templateRootPath,
    });
  }
  await copyDirectoryAtomically(artifact.templateRootPath, sessionRootPath);
}

async function openHandle(
  context: SandboxProviderSessionContext,
  rootPath: string,
  options: JustBashSandboxCreateOptions,
) {
  const sandbox = await createBashSandbox({
    autoInstall: options.autoInstall ?? true,
    customCommands: options.customCommands,
    filesystem: options.filesystem,
    host: context.host,
    rootPath,
    sessionKey: context.session.id,
    storagePath: context.storagePath,
  });
  return createJustBashHandle(sandbox);
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

function requirePreparedJustBashArtifact(
  artifact: SandboxPreparedArtifact,
): JustBashPreparedArtifact {
  if (!isSandboxPreparedArtifactRecord(artifact) || typeof artifact.templateRootPath !== "string") {
    throw new Error("Invalid prepared just-bash artifact.");
  }
  return { templateRootPath: artifact.templateRootPath };
}

function requireJustBashSessionState(state: SandboxPreparedArtifact): JustBashSessionState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 2 ||
    typeof state.generation !== "string" ||
    typeof state.rootPath !== "string"
  ) {
    throw new Error("Invalid just-bash session state.");
  }
  return { generation: state.generation, rootPath: state.rootPath, version: 2 };
}

function resolveTemplateRootPath(storagePath: string, key: string): string {
  return resolveLocalProviderTemplateRootPath(storagePath, JUST_BASH_CACHE_DIRECTORY_NAME, key);
}

function resolveSessionRootPath(storagePath: string, key: string): string {
  return resolveLocalProviderSessionRootPath(storagePath, JUST_BASH_CACHE_DIRECTORY_NAME, key);
}
