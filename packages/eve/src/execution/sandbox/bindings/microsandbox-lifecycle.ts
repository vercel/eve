import { randomUUID } from "node:crypto";

import {
  hydrateSandboxFromImmutableResources,
  prepareImmutableResources,
  resolveImmutableResourcesPath,
} from "#execution/sandbox/bindings/immutable-resources.js";

import {
  assertDockerDaemonAvailable,
  createDockerCli,
} from "#execution/sandbox/bindings/docker-cli.js";
import {
  buildSandboxDockerfile,
  dockerfileImageReference,
  publishDockerImageForMicrosandbox,
} from "#execution/sandbox/dockerfile.js";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createFileBackedInternalSandboxSession,
  touchDirectory,
  writeSandboxSeedFiles,
} from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  MICROSANDBOX_METADATA_VERSION,
  type MicrosandboxTemplateMetadata,
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
import {
  isSandboxPreparedArtifactRecord,
  providerResourceRoot,
  type SandboxPreparedArtifact,
  type SandboxProviderCreateContext,
  type SandboxProviderHandle,
  type SandboxProviderPrepareContext,
  type SandboxProviderPreparedArtifact,
  type SandboxProviderResources,
} from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type { InternalSandboxSession } from "#shared/sandbox-session.js";

const activeMicrosandboxSessionHandles = new Map<
  string,
  SandboxProviderHandle<Record<string, unknown>>
>();

export async function prewarmMicrosandboxTemplate(input: {
  readonly providerName: string;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
  readonly context: SandboxProviderPrepareContext;
}): Promise<{ readonly artifact: SandboxPreparedArtifact; readonly reused: boolean }> {
  input.context.log?.("loading microsandbox runtime");
  const module = await loadMicrosandboxModule({
    appRoot: input.context.appRoot,
    log: input.context.log,
    options: input.options,
  });
  const cacheDirectory = resolveSandboxCacheDirectory(input.context.appRoot);
  const templateRootPath = resolveMicrosandboxTemplateRootPath(
    cacheDirectory,
    input.context.templateName,
  );
  const metadataPath = resolveMicrosandboxMetadataPath(templateRootPath);
  input.context.log?.("checking cached snapshot");
  const existing = await readTemplateMetadata(metadataPath);

  if (
    existing?.optionsHash === input.optionsHash &&
    (await snapshotExists(module, existing.snapshotName))
  ) {
    input.context.log?.("reusing cached snapshot");
    await touchDirectory(templateRootPath);
    return { artifact: microsandboxTemplateArtifact(existing), reused: true };
  }

  const snapshotName = createProviderName(
    "eve-sbx-tpl",
    input.context.templateName,
    input.optionsHash,
  );
  const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
  const temporarySandboxName = createProviderName(
    "eve-sbx-tpl-tmp",
    `${input.context.templateName}:${randomUUID()}`,
  );

  await removeSnapshotIfExists(module, snapshotName);
  await rm(temporaryTemplateRootPath, { force: true, recursive: true });
  await mkdir(temporaryTemplateRootPath, { recursive: true });

  let templateOptions = input.options;
  if (input.context.dockerfile !== undefined) {
    const cli = createDockerCli();
    await assertDockerDaemonAvailable(cli);
    const imageReference = dockerfileImageReference({
      dockerfile: input.context.dockerfile,
      templateKey: input.context.templateName,
    });
    input.context.log?.(`building sandbox Dockerfile "${input.context.dockerfile.path}"`);
    await buildSandboxDockerfile({
      cli,
      dockerfile: input.context.dockerfile,
      imageReference,
    });
    input.context.log?.("publishing Dockerfile image for microsandbox");
    const publishedImage = await publishDockerImageForMicrosandbox({ cli, imageReference });
    templateOptions = { ...input.options, image: publishedImage, pullPolicy: "always" };
  }

  const resourceRoot = providerResourceRoot(input.context.resources);
  const resourcesPath =
    resourceRoot.key === undefined || resourceRoot.path === undefined
      ? undefined
      : await prepareImmutableResources({
          appRoot: input.context.appRoot,
          provider: input.providerName,
          resourcesKey: resourceRoot.key,
          sourcePath: resourceRoot.path,
        });
  input.context.log?.(`creating template VM from image "${templateOptions.image}"`);
  const templateSandbox = await createPreparedMicrosandbox({
    log: input.context.log,
    module,
    name: temporarySandboxName,
    networkPolicy: templateOptions.networkPolicy,
    options: templateOptions,
    resourcesPath,
    sessionKey: input.context.templateName,
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
    if (resourcesPath === undefined) {
      await writeSandboxSeedFiles(templateSession, providerSeedFiles(input.context.resources));
    } else {
      input.context.log?.("hydrating workspace and skills from read-only resources");
      await hydrateSandboxFromImmutableResources(templateSession);
    }

    input.context.log?.("running sandbox preparation");
    await input.context.runPreparation(
      createLoggingSandboxSession({ log: input.context.log, session: templateSession }),
    );

    input.context.log?.("snapshotting template VM");
    await templateSandbox.stopAndSnapshot(snapshotName);
    await writeTemplateMetadata(resolveMicrosandboxMetadataPath(temporaryTemplateRootPath), {
      image: input.context.dockerfile === undefined ? undefined : templateOptions.image,
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
        const published = await readTemplateMetadata(metadataPath);
        if (published !== null) {
          return { artifact: microsandboxTemplateArtifact(published), reused: true };
        }
      }
      throw error;
    }
  } finally {
    await templateSandbox.removePersisted();
    await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
  }

  return {
    artifact: microsandboxTemplateArtifact({
      image: input.context.dockerfile === undefined ? undefined : templateOptions.image,
      optionsHash: input.optionsHash,
      snapshotName,
      version: MICROSANDBOX_METADATA_VERSION,
    }),
    reused: false,
  };
}

export async function createMicrosandboxHandle(input: {
  readonly providerName: string;
  readonly context: SandboxProviderCreateContext<undefined, Record<string, unknown>>;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
  readonly prepared?: SandboxProviderPreparedArtifact;
}): Promise<SandboxProviderHandle<Record<string, unknown>>> {
  const cacheDirectory = resolveSandboxCacheDirectory(input.context.appRoot);
  const templateMetadata =
    input.prepared === undefined
      ? null
      : requirePreparedMicrosandboxTemplate(
          input.prepared.artifact,
          input.prepared.templateName,
          input.providerName,
        );
  const existingMetadata =
    readSessionMetadataRecord(input.context.existing) ??
    (await readSessionMetadata(
      resolveMicrosandboxMetadataPath(
        resolveMicrosandboxSessionRootPath(cacheDirectory, input.context.sandboxName),
      ),
    ));
  const image = existingMetadata?.image ?? templateMetadata?.image;
  const options =
    image === undefined
      ? input.options
      : { ...input.options, image, pullPolicy: "always" as const };
  const module = await loadMicrosandboxModule({
    appRoot: input.context.appRoot,
    options,
  });
  const sessionRootPath = resolveMicrosandboxSessionRootPath(
    cacheDirectory,
    input.context.sandboxName,
  );
  const activeSessionKey = createActiveMicrosandboxSessionKey(sessionRootPath, input.optionsHash);
  const activeHandle = activeMicrosandboxSessionHandles.get(activeSessionKey);
  if (activeHandle !== undefined) {
    return activeHandle;
  }

  const metadataPath = resolveMicrosandboxMetadataPath(sessionRootPath);
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
      options,
      sessionKey: input.context.sandboxName,
      tags: sessionTags,
    });
    if (sandbox !== null) {
      return input.context.handle(
        cacheHandle(
          activeSessionKey,
          createHandle(sandbox, input.optionsHash, () => {
            activeMicrosandboxSessionHandles.delete(activeSessionKey);
          }),
        ),
      );
    }
  }

  let snapshotName: string | null = null;
  if (input.prepared !== undefined) {
    if (
      templateMetadata === null ||
      templateMetadata.optionsHash !== input.optionsHash ||
      !(await snapshotExists(module, templateMetadata.snapshotName))
    ) {
      throw new SandboxTemplateNotProvisionedError({
        providerName: input.providerName,
        templateKey: input.prepared.templateName,
      });
    }

    snapshotName = templateMetadata.snapshotName;
  }

  const sandboxName = createProviderName(
    "eve-sbx-ses",
    `${input.context.sandboxName}:${randomUUID()}`,
  );
  let sandbox: MicrosandboxVm;
  try {
    sandbox = await createPreparedMicrosandbox({
      fromSnapshot: snapshotName ?? undefined,
      module,
      name: sandboxName,
      networkPolicy: options.networkPolicy,
      options,
      resourcesPath: resolveProviderResourcesPath(
        input.context.resources,
        input.context.appRoot,
        input.providerName,
      ),
      sessionKey: input.context.sandboxName,
      setupBaseRuntime: snapshotName === null,
      tags: sessionTags,
    });
  } catch (error) {
    if (
      snapshotName !== null &&
      input.prepared !== undefined &&
      isMicrosandboxNotFoundError(error)
    ) {
      throw new SandboxTemplateNotProvisionedError({
        providerName: input.providerName,
        templateKey: input.prepared.templateName,
      });
    }
    throw error;
  }

  await sandbox.writeMetadata(metadataPath, input.optionsHash);
  return input.context.handle(
    cacheHandle(
      activeSessionKey,
      createHandle(sandbox, input.optionsHash, () => {
        activeMicrosandboxSessionHandles.delete(activeSessionKey);
      }),
    ),
  );
}

function microsandboxTemplateArtifact(
  metadata: MicrosandboxTemplateMetadata,
): SandboxPreparedArtifact {
  const artifact: Record<string, SandboxPreparedArtifact> = {
    optionsHash: metadata.optionsHash,
    snapshotName: metadata.snapshotName,
    version: metadata.version,
  };
  if (metadata.image !== undefined) artifact.image = metadata.image;
  return artifact;
}

function requirePreparedMicrosandboxTemplate(
  artifact: SandboxPreparedArtifact | undefined,
  templateKey: string,
  providerName: string,
): MicrosandboxTemplateMetadata {
  if (
    !isSandboxPreparedArtifactRecord(artifact) ||
    artifact.version !== MICROSANDBOX_METADATA_VERSION ||
    typeof artifact.optionsHash !== "string" ||
    typeof artifact.snapshotName !== "string"
  ) {
    throw new SandboxTemplateNotProvisionedError({ providerName, templateKey });
  }
  return {
    image: typeof artifact.image === "string" ? artifact.image : undefined,
    optionsHash: artifact.optionsHash,
    snapshotName: artifact.snapshotName,
    version: MICROSANDBOX_METADATA_VERSION,
  };
}

function createHandle(
  sandbox: MicrosandboxVm,
  optionsHash: string,
  onShutdown?: () => void,
): SandboxProviderHandle<Record<string, unknown>> {
  const session = buildSandboxSession(
    createMicrosandboxInternalSession(sandbox),
    async (policy) => {
      await sandbox.setNetworkPolicy(policy);
    },
  );
  return {
    captureMetadata: async () => ({ ...(await sandbox.captureState(optionsHash)) }),
    metadata: {},
    sandbox: session,
    async delete() {
      await sandbox.shutdown();
      await sandbox.removePersisted();
      onShutdown?.();
    },
    async stop() {
      await sandbox.stop();
      onShutdown?.();
    },
    async shutdown() {
      onShutdown?.();
      await sandbox.shutdown();
    },
  };
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

function resolveProviderResourcesPath(
  resources: SandboxProviderResources,
  appRoot: string,
  provider: string,
): string | undefined {
  const root = providerResourceRoot(resources);
  return root.key === undefined
    ? undefined
    : resolveImmutableResourcesPath({ appRoot, provider, resourcesKey: root.key });
}

function createMicrosandboxInternalSession(sandbox: MicrosandboxVm): InternalSandboxSession {
  return createFileBackedInternalSandboxSession({ id: sandbox.id, sandbox });
}

function createActiveMicrosandboxSessionKey(sessionRootPath: string, optionsHash: string): string {
  return `${sessionRootPath}\0${optionsHash}`;
}

function cacheHandle(
  key: string,
  handle: SandboxProviderHandle<Record<string, unknown>>,
): SandboxProviderHandle<Record<string, unknown>> {
  activeMicrosandboxSessionHandles.set(key, handle);
  return handle;
}

export function clearActiveMicrosandboxSessionHandlesForTest(): void {
  activeMicrosandboxSessionHandles.clear();
}
