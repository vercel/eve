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
} from "#execution/sandbox/bindings/local-workspace-utils.js";
import {
  createBashSandbox,
  createJustBashSandboxSession,
  justBashSetNetworkPolicyUnsupported,
  type BashSandbox,
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
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-errors.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { SandboxProviderContext } from "#shared/sandbox-value.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const JUST_BASH_CACHE_DIRECTORY_NAME = "just-bash";

/**
 * Stable provider name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const JUST_BASH_PROVIDER = "just-bash";

export interface CreateJustBashSandboxProviderInput {
  readonly createOptions?: JustBashSandboxCreateOptions;
}

export interface JustBashSandboxTemplateReference extends JsonObject {
  readonly rootPath: string;
  readonly templateId: string;
}

export interface JustBashSandboxReference extends JsonObject {
  readonly configuration: JsonObject;
  readonly resourceId: string;
  readonly rootPath: string;
  readonly sessionKey: string;
}

export interface JustBashSandboxResource {
  readonly configuration: JsonObject;
  readonly sandbox: BashSandbox;
  readonly session: SandboxSession;
  shutdown(): Promise<void>;
}

export interface JustBashSandboxProvider {
  create(input: {
    readonly context: SandboxProviderContext;
    readonly reference?: JustBashSandboxReference;
    readonly template?: JustBashSandboxTemplateReference;
  }): Promise<JustBashSandboxResource>;
  prewarm(input: {
    readonly appRoot: string;
    readonly log?: (message: string) => void;
    readonly prepare: (resource: JustBashSandboxResource) => Promise<void>;
    readonly templateId: string;
  }): Promise<JustBashSandboxTemplateReference>;
}

const activeJustBashResources = new Map<string, Promise<JustBashSandboxResource>>();

/**
 * Creates the just-bash sandbox provider.
 *
 * The cache directory is derived from the runtime context's `appRoot`
 * on every `create` call so the provider stays stateless and matches
 * the framework's per-call dispatch contract.
 */
export function createJustBashSandboxProvider(
  input: CreateJustBashSandboxProviderInput = {},
): JustBashSandboxProvider {
  const autoInstall = input.createOptions?.autoInstall ?? true;
  const configuration = parseJsonObject(input.createOptions ?? {});
  return {
    async prewarm(prewarmInput): Promise<JustBashSandboxTemplateReference> {
      const cacheDirectory = resolveSandboxCacheDirectory(prewarmInput.appRoot);
      const templateRootPath = resolveTemplateRootPath(cacheDirectory, prewarmInput.templateId);

      if (await pathExists(templateRootPath)) {
        await touchDirectory(templateRootPath);
        return { rootPath: templateRootPath, templateId: prewarmInput.templateId };
      }

      const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
      let published = false;
      const templateSandbox = await createBashSandbox({
        appRoot: prewarmInput.appRoot,
        autoInstall,
        rootPath: temporaryTemplateRootPath,
        sessionKey: prewarmInput.templateId,
      });
      const templateSession = buildSandboxSession(
        createFileBackedInternalSandboxSession({
          id: templateSandbox.sessionKey,
          sandbox: templateSandbox,
        }),
        justBashSetNetworkPolicyUnsupported,
      );

      try {
        prewarmInput.log?.("running template preparation");
        await prewarmInput.prepare({
          configuration,
          sandbox: templateSandbox,
          session: createLoggingSandboxSession({
            log: prewarmInput.log,
            session: templateSession,
          }),
          async shutdown() {},
        });

        const captured = await templateSandbox.captureState();
        if (captured === null) {
          throw new Error(
            `Failed to capture local sandbox template state for "${prewarmInput.templateId}".`,
          );
        }

        await mkdir(dirname(templateRootPath), { recursive: true });
        try {
          await rename(temporaryTemplateRootPath, templateRootPath);
          published = true;
        } catch (error) {
          if (await pathExists(templateRootPath)) {
            return { rootPath: templateRootPath, templateId: prewarmInput.templateId };
          }
          throw error;
        }
      } finally {
        await templateSandbox.dispose();
        if (!published) {
          await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
        }
      }

      return { rootPath: templateRootPath, templateId: prewarmInput.templateId };
    },
    async create(createInput): Promise<JustBashSandboxResource> {
      const cacheDirectory = resolveSandboxCacheDirectory(createInput.context.appRoot);
      const persistedIdentity = createInput.reference;
      const sessionKey = createInput.reference?.sessionKey ?? createInput.context.resourceId;
      const sessionRootPath =
        persistedIdentity?.rootPath ?? resolveSessionRootPath(cacheDirectory, sessionKey);
      const active = activeJustBashResources.get(sessionRootPath);
      if (active !== undefined) {
        const resource = await expectJustBashResourceIdentity(
          active,
          persistedIdentity,
          sessionKey,
        );
        if (await pathExists(sessionRootPath)) {
          return resource;
        }
        await resource.shutdown();
        if (persistedIdentity !== undefined) {
          throw new SandboxResourceUnavailableError({
            provider: JUST_BASH_PROVIDER,
            sessionKey,
          });
        }
      }

      let resourcePromise: Promise<JustBashSandboxResource>;
      resourcePromise = (async () => {
        let createdSessionRoot = false;

        if (!(await pathExists(sessionRootPath))) {
          if (createInput.reference !== undefined) {
            throw new SandboxResourceUnavailableError({
              provider: JUST_BASH_PROVIDER,
              sessionKey,
            });
          }
          if (createInput.template === undefined) {
            await mkdir(sessionRootPath, { recursive: true });
            createdSessionRoot = true;
          } else {
            const templateRootPath = createInput.template.rootPath;

            if (!(await pathExists(templateRootPath))) {
              throw new SandboxTemplateUnavailableError({
                provider: JUST_BASH_PROVIDER,
                templateKey: createInput.template.templateId,
              });
            }

            await copyDirectoryAtomically(templateRootPath, sessionRootPath);
            createdSessionRoot = true;
          }
        }

        const sandbox = await createBashSandbox({
          appRoot: createInput.context.appRoot,
          autoInstall,
          resourceId: createdSessionRoot ? randomUUID() : undefined,
          rootPath: sessionRootPath,
          sessionKey,
        });
        if (
          persistedIdentity !== undefined &&
          sandbox.resourceId !== persistedIdentity.resourceId
        ) {
          await sandbox.dispose();
          throw new SandboxResourceUnavailableError({
            provider: JUST_BASH_PROVIDER,
            sessionKey,
          });
        }

        return {
          configuration,
          sandbox,
          session: createJustBashSandboxSession(sandbox),
          async shutdown() {
            if (activeJustBashResources.get(sessionRootPath) === resourcePromise) {
              activeJustBashResources.delete(sessionRootPath);
            }
            await sandbox.dispose();
          },
        };
      })();
      activeJustBashResources.set(sessionRootPath, resourcePromise);

      try {
        return await resourcePromise;
      } catch (error) {
        if (activeJustBashResources.get(sessionRootPath) === resourcePromise) {
          activeJustBashResources.delete(sessionRootPath);
        }
        throw error;
      }
    },
  };
}

async function expectJustBashResourceIdentity(
  resourcePromise: Promise<JustBashSandboxResource>,
  reference: JustBashSandboxReference | undefined,
  sessionKey: string,
): Promise<JustBashSandboxResource> {
  const resource = await resourcePromise;
  if (reference !== undefined && resource.sandbox.resourceId !== reference.resourceId) {
    throw new SandboxResourceUnavailableError({
      provider: JUST_BASH_PROVIDER,
      sessionKey,
    });
  }
  return resource;
}

export async function referenceJustBashSandboxResource(
  resource: JustBashSandboxResource,
): Promise<JustBashSandboxReference> {
  await resource.sandbox.captureState();
  return {
    configuration: resource.configuration,
    resourceId: resource.sandbox.resourceId,
    rootPath: resource.sandbox.rootPath,
    sessionKey: resource.sandbox.sessionKey,
  };
}

export async function restoreJustBashSandboxResource(
  reference: JustBashSandboxReference,
  context: SandboxProviderContext,
): Promise<JustBashSandboxResource> {
  return await createJustBashSandboxProvider({
    createOptions: decodeJustBashSandboxCreateOptions(reference.configuration),
  }).create({ context, reference });
}

function decodeJustBashSandboxCreateOptions(value: JsonObject): JustBashSandboxCreateOptions {
  if (
    Object.keys(value).some((key) => key !== "autoInstall") ||
    (value.autoInstall !== undefined && typeof value.autoInstall !== "boolean")
  ) {
    throw new TypeError("Invalid just-bash sandbox configuration in durable state.");
  }
  return { autoInstall: value.autoInstall };
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
  return resolveLocalProviderTemplateRootPath(
    cacheDirectory,
    JUST_BASH_CACHE_DIRECTORY_NAME,
    templateKey,
  );
}

function resolveSessionRootPath(cacheDirectory: string, sessionKey: string): string {
  return resolveLocalProviderSessionRootPath(
    cacheDirectory,
    JUST_BASH_CACHE_DIRECTORY_NAME,
    sessionKey,
  );
}
