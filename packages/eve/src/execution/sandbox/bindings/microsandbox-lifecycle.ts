import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createFileBackedInternalSandboxSession,
  touchDirectory,
} from "#execution/sandbox/bindings/local-workspace-utils.js";
import {
  MICROSANDBOX_METADATA_VERSION,
  readSessionMetadata,
  readSessionMetadataRecord,
  readTemplateMetadata,
  resolveMicrosandboxMetadataPath,
  writeTemplateMetadata,
} from "#execution/sandbox/bindings/microsandbox-metadata.js";
import type { ResolvedMicrosandboxOptions } from "#execution/sandbox/bindings/microsandbox-options.js";
import {
  connectMicrosandbox,
  createPreparedMicrosandbox,
  createProviderName,
  doesPathExist,
  isMicrosandboxNotFoundError,
  loadMicrosandboxModule,
  type MicrosandboxVm,
  removeSnapshotIfExists,
  sandboxExists,
  snapshotExists,
} from "#execution/sandbox/bindings/microsandbox-runtime.js";
import {
  resolveMicrosandboxSessionRootPath,
  resolveMicrosandboxTemplateRootPath,
} from "#execution/sandbox/bindings/microsandbox-templates.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { withDevelopmentSandboxMetadataPathTag } from "#execution/sandbox/development-run.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-errors.js";
import type { SandboxProviderContext } from "#shared/sandbox-value.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import type { InternalSandboxSession } from "#shared/sandbox-session.js";

export interface MicrosandboxTemplateReference extends JsonObject {
  readonly optionsHash: string;
  readonly snapshotName: string;
  readonly templateId: string;
}

export interface MicrosandboxReference extends JsonObject {
  readonly configuration: JsonObject;
  readonly metadata: JsonObject;
  readonly sessionKey: string;
}

export interface MicrosandboxResource {
  readonly configuration: JsonObject;
  readonly optionsHash: string;
  readonly sandbox: MicrosandboxVm;
  readonly session: SandboxSession;
  shutdown(): Promise<void>;
}

const activeMicrosandboxSessionHandles = new Map<string, MicrosandboxResource>();

export async function prewarmMicrosandboxTemplate(input: {
  readonly appRoot: string;
  readonly configuration: JsonObject;
  readonly log?: (message: string) => void;
  readonly provider: string;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
  readonly prepare: (resource: MicrosandboxResource) => Promise<void>;
  readonly templateId: string;
}): Promise<MicrosandboxTemplateReference> {
  input.log?.("loading microsandbox runtime");
  const module = await loadMicrosandboxModule({
    appRoot: input.appRoot,
    log: input.log,
    options: input.options,
  });
  const cacheDirectory = resolveSandboxCacheDirectory(input.appRoot);
  const templateRootPath = resolveMicrosandboxTemplateRootPath(cacheDirectory, input.templateId);
  const metadataPath = resolveMicrosandboxMetadataPath(templateRootPath);
  input.log?.("checking cached snapshot");
  const existing = await readTemplateMetadata(metadataPath);

  if (
    existing?.optionsHash === input.optionsHash &&
    input.options.pullPolicy !== "always" &&
    isImmutableOciImageReference(input.options.image) &&
    (await snapshotExists(module, existing.snapshotName))
  ) {
    input.log?.("reusing cached snapshot");
    await touchDirectory(templateRootPath);
    return {
      optionsHash: input.optionsHash,
      snapshotName: existing.snapshotName,
      templateId: input.templateId,
    };
  }

  const snapshotName = createProviderName("eve-sbx-tpl", input.templateId, input.optionsHash);
  const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
  const temporarySandboxName = createProviderName(
    "eve-sbx-tpl-tmp",
    `${input.templateId}:${randomUUID()}`,
  );

  await removeSnapshotIfExists(module, snapshotName);
  await rm(temporaryTemplateRootPath, { force: true, recursive: true });
  await mkdir(temporaryTemplateRootPath, { recursive: true });

  input.log?.(`creating template VM from image "${input.options.image}"`);
  const templateSandbox = await createPreparedMicrosandbox({
    log: input.log,
    module,
    name: temporarySandboxName,
    networkPolicy: input.options.networkPolicy,
    options: input.options,
    sessionKey: input.templateId,
    setupBaseRuntime: true,
    tags: undefined,
  });
  const templateSession = buildSandboxSession(
    createMicrosandboxInternalSession(templateSandbox),
    async (policy) => {
      await templateSandbox.setNetworkPolicy(policy);
    },
  );

  try {
    input.log?.("running template preparation");
    await input.prepare(
      createHandle(
        templateSandbox,
        input.configuration,
        input.optionsHash,
        undefined,
        createLoggingSandboxSession({
          log: input.log,
          session: templateSession,
        }),
      ),
    );

    input.log?.("snapshotting template VM");
    await templateSandbox.stopAndSnapshot(snapshotName);
    await writeTemplateMetadata(resolveMicrosandboxMetadataPath(temporaryTemplateRootPath), {
      optionsHash: input.optionsHash,
      snapshotName,
      version: MICROSANDBOX_METADATA_VERSION,
    });

    await mkdir(dirname(templateRootPath), { recursive: true });
    await rm(templateRootPath, { force: true, recursive: true });
    try {
      await rename(temporaryTemplateRootPath, templateRootPath);
    } catch (error) {
      if (await doesPathExist(templateRootPath)) {
        const published = await readTemplateMetadata(
          resolveMicrosandboxMetadataPath(templateRootPath),
        );
        if (published !== null) {
          return {
            optionsHash: input.optionsHash,
            snapshotName: published.snapshotName,
            templateId: input.templateId,
          };
        }
      }
      throw error;
    }
  } finally {
    await templateSandbox.removePersisted();
    await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
  }

  return {
    optionsHash: input.optionsHash,
    snapshotName,
    templateId: input.templateId,
  };
}

export async function createMicrosandboxResource(input: {
  readonly context: SandboxProviderContext;
  readonly provider: string;
  readonly configuration?: JsonObject;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
  readonly reference?: MicrosandboxReference;
  readonly template?: MicrosandboxTemplateReference;
}): Promise<MicrosandboxResource> {
  const module = await loadMicrosandboxModule({
    appRoot: input.context.appRoot,
    options: input.options,
  });
  const sessionKey = input.reference?.sessionKey ?? input.context.resourceId;
  const cacheDirectory = resolveSandboxCacheDirectory(input.context.appRoot);
  const sessionRootPath = resolveMicrosandboxSessionRootPath(cacheDirectory, sessionKey);
  const activeSessionKey = createActiveMicrosandboxSessionKey(sessionRootPath, input.optionsHash);
  const activeHandle = activeMicrosandboxSessionHandles.get(activeSessionKey);
  if (activeHandle !== undefined) {
    return activeHandle;
  }

  const metadataPath = resolveMicrosandboxMetadataPath(sessionRootPath);
  // Child workflows can advance a shared sandbox after parent state was serialized,
  // so provider metadata must win over the workflow reference.
  const existingMetadata =
    (await readSessionMetadata(metadataPath)) ??
    readSessionMetadataRecord(input.reference?.metadata);
  const sessionTags = withDevelopmentSandboxMetadataPathTag(input.context.tags, metadataPath);

  if (
    existingMetadata?.optionsHash === input.optionsHash &&
    ((await sandboxExists(module, existingMetadata.sandboxName)) ||
      (existingMetadata.stateSnapshotName !== undefined &&
        (await snapshotExists(module, existingMetadata.stateSnapshotName))))
  ) {
    const sandbox = await connectMicrosandbox({
      metadata: existingMetadata,
      metadataPath,
      module,
      options: input.options,
      sessionKey,
      tags: sessionTags,
    });
    if (sandbox !== null) {
      return cacheHandle(
        activeSessionKey,
        createHandle(sandbox, input.configuration ?? {}, input.optionsHash, () => {
          activeMicrosandboxSessionHandles.delete(activeSessionKey);
        }),
      );
    }
  }

  if (input.reference !== undefined) {
    throw new SandboxResourceUnavailableError({
      provider: input.provider,
      sessionKey,
    });
  }

  let snapshotName: string | null = null;
  if (input.template !== undefined) {
    if (
      input.template.optionsHash !== input.optionsHash ||
      !(await snapshotExists(module, input.template.snapshotName))
    ) {
      throw new SandboxTemplateUnavailableError({
        provider: input.provider,
        templateKey: input.template.templateId,
      });
    }

    snapshotName = input.template.snapshotName;
  }

  const sandboxName = createProviderName("eve-sbx-ses", `${sessionKey}:${randomUUID()}`);
  let sandbox: MicrosandboxVm;
  try {
    sandbox = await createPreparedMicrosandbox({
      fromSnapshot: snapshotName ?? undefined,
      module,
      name: sandboxName,
      networkPolicy: input.options.networkPolicy,
      options: input.options,
      sessionKey,
      setupBaseRuntime: snapshotName === null,
      tags: sessionTags,
    });
  } catch (error) {
    if (
      snapshotName !== null &&
      input.template !== undefined &&
      isMicrosandboxNotFoundError(error)
    ) {
      throw new SandboxTemplateUnavailableError({
        provider: input.provider,
        templateKey: input.template.templateId,
      });
    }
    throw error;
  }

  await sandbox.writeMetadata(metadataPath, input.optionsHash);
  return cacheHandle(
    activeSessionKey,
    createHandle(sandbox, input.configuration ?? {}, input.optionsHash, () => {
      activeMicrosandboxSessionHandles.delete(activeSessionKey);
    }),
  );
}

function createHandle(
  sandbox: MicrosandboxVm,
  configuration: JsonObject,
  optionsHash: string,
  onShutdown?: () => void,
  session = buildSandboxSession(createMicrosandboxInternalSession(sandbox), async (policy) => {
    await sandbox.setNetworkPolicy(policy);
  }),
): MicrosandboxResource {
  return {
    configuration,
    optionsHash,
    sandbox,
    session,
    async shutdown() {
      onShutdown?.();
      await sandbox.shutdown();
    },
  };
}

export async function referenceMicrosandboxResource(
  resource: MicrosandboxResource,
): Promise<MicrosandboxReference> {
  return {
    configuration: resource.configuration,
    metadata: parseJsonObject(await resource.sandbox.captureState(resource.optionsHash)),
    sessionKey: resource.sandbox.id,
  };
}

function createMicrosandboxInternalSession(sandbox: MicrosandboxVm): InternalSandboxSession {
  return createFileBackedInternalSandboxSession({ id: sandbox.id, sandbox });
}

function createActiveMicrosandboxSessionKey(sessionRootPath: string, optionsHash: string): string {
  return `${sessionRootPath}\0${optionsHash}`;
}

function cacheHandle(key: string, handle: MicrosandboxResource): MicrosandboxResource {
  activeMicrosandboxSessionHandles.set(key, handle);
  return handle;
}

export function clearActiveMicrosandboxSessionHandlesForTest(): void {
  activeMicrosandboxSessionHandles.clear();
}

function isImmutableOciImageReference(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}
