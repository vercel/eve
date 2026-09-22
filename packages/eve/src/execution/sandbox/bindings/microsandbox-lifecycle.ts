import { randomUUID } from "node:crypto";

import {
  hydrateSandboxProviderResources,
  prepareImmutableResources,
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
} from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  MICROSANDBOX_METADATA_VERSION,
  type MicrosandboxSessionMetadata,
  type MicrosandboxTemplateMetadata,
  readSessionMetadata,
  readTemplateMetadata,
  resolveMicrosandboxMetadataPath,
  writeTemplateMetadata,
} from "#execution/sandbox/bindings/microsandbox-metadata.js";
import type { ResolvedMicrosandboxOptions } from "#execution/sandbox/bindings/microsandbox-options.js";
import type { MicrosandboxSandboxRuntimeOptions } from "#public/sandbox/microsandbox-sandbox.js";
import {
  connectMicrosandbox,
  createPreparedMicrosandbox,
  createProviderName,
  createStableHash,
  doesPathExist,
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
import {
  isSandboxPreparedArtifactRecord,
  type SandboxPreparedArtifact,
  type SandboxProviderSessionContext,
  type SandboxProviderHandle,
  type SandboxProviderPrepareContext,
} from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type {
  InternalSandboxSession,
  MutableNetworkSandboxSession,
} from "#shared/sandbox-session.js";

type LiveMicrosandboxOptions = ResolvedMicrosandboxOptions & MicrosandboxSandboxRuntimeOptions;

export type MicrosandboxPreparedArtifact = {
  readonly image: string | null;
  readonly optionsHash: string;
  readonly snapshotName: string;
  readonly version: typeof MICROSANDBOX_METADATA_VERSION;
};

const activeMicrosandboxSessionHandles = new Map<
  string,
  SandboxProviderHandle<MutableNetworkSandboxSession>
>();

export async function prewarmMicrosandboxTemplate(input: {
  readonly providerName: string;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
  readonly context: SandboxProviderPrepareContext;
  readonly dockerfile?: import("#execution/sandbox/dockerfile.js").SandboxDockerfile;
  readonly prepare?: (
    sandbox: import("#shared/sandbox-session.js").SandboxSession,
  ) => Promise<void> | void;
  readonly templateKey: string;
}): Promise<MicrosandboxPreparedArtifact> {
  input.context.log?.("loading microsandbox runtime");
  const module = await loadMicrosandboxModule({
    host: input.context.host,
    log: input.context.log,
    options: input.options,
  });
  const cacheDirectory = input.context.storagePath;
  const templateRootPath = resolveMicrosandboxTemplateRootPath(cacheDirectory, input.templateKey);
  const metadataPath = resolveMicrosandboxMetadataPath(templateRootPath);
  input.context.log?.("checking cached snapshot");
  const existing = await readTemplateMetadata(metadataPath);

  if (
    existing?.optionsHash === input.optionsHash &&
    (await snapshotExists(module, existing.snapshotName))
  ) {
    input.context.log?.("reusing cached snapshot");
    await touchDirectory(templateRootPath);
    return microsandboxTemplateArtifact(existing);
  }

  const snapshotName = createProviderName("eve-sbx-tpl", input.templateKey, input.optionsHash);
  const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
  const temporarySandboxName = createProviderName(
    "eve-sbx-tpl-tmp",
    `${input.templateKey}:${randomUUID()}`,
  );

  await removeSnapshotIfExists(module, snapshotName);
  await rm(temporaryTemplateRootPath, { force: true, recursive: true });
  await mkdir(temporaryTemplateRootPath, { recursive: true });

  let templateOptions = input.options;
  if (input.dockerfile !== undefined) {
    const cli = createDockerCli();
    await assertDockerDaemonAvailable(cli);
    const imageReference = dockerfileImageReference({
      dockerfile: input.dockerfile,
      templateKey: input.templateKey,
    });
    input.context.log?.(`building sandbox Dockerfile "${input.dockerfile.path}"`);
    await buildSandboxDockerfile({
      cli,
      dockerfile: input.dockerfile,
      imageReference,
    });
    input.context.log?.("publishing Dockerfile image for microsandbox");
    const publishedImage = await publishDockerImageForMicrosandbox({ cli, imageReference });
    templateOptions = { ...input.options, image: publishedImage, pullPolicy: "always" };
  }

  const resourceSource = input.context.resources.source;
  const resourcesPath =
    resourceSource.kind === "materialized"
      ? await prepareImmutableResources({
          storagePath: input.context.storagePath,
          provider: input.providerName,
          resourcesKey: resourceSource.key,
          sourcePath: resourceSource.path,
        })
      : undefined;
  input.context.log?.(`creating template VM from image "${templateOptions.image}"`);
  const templateSandbox = await createPreparedMicrosandbox({
    log: input.context.log,
    module,
    name: temporarySandboxName,
    networkPolicy: "allow-all",
    options: templateOptions,
    resourcesPath,
    sessionKey: input.templateKey,
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
    await hydrateSandboxProviderResources({
      copySkills: true,
      log: input.context.log,
      resources: input.context.resources,
      session: templateSession,
    });

    if (input.prepare !== undefined) {
      input.context.log?.("running sandbox preparation");
      await input.prepare(
        createLoggingSandboxSession({ log: input.context.log, session: templateSession }),
      );
    }

    input.context.log?.("snapshotting template VM");
    await templateSandbox.stopAndSnapshot(snapshotName);
    await writeTemplateMetadata(resolveMicrosandboxMetadataPath(temporaryTemplateRootPath), {
      image: input.dockerfile === undefined ? undefined : templateOptions.image,
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
          return microsandboxTemplateArtifact(published);
        }
      }
      throw error;
    }
  } finally {
    await templateSandbox.removePersisted();
    await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
  }

  return microsandboxTemplateArtifact({
    image: input.dockerfile === undefined ? undefined : templateOptions.image,
    optionsHash: input.optionsHash,
    snapshotName,
    version: MICROSANDBOX_METADATA_VERSION,
  });
}

export async function createMicrosandboxHandle(input: {
  readonly artifact: MicrosandboxPreparedArtifact;
  readonly context: SandboxProviderSessionContext;
  readonly createIfMissing?: boolean;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
  readonly providerName: string;
  readonly runtimeOptions?: MicrosandboxSandboxRuntimeOptions;
  readonly sessionIdentity?: string;
}): Promise<{
  readonly handle: SandboxProviderHandle<MutableNetworkSandboxSession>;
  readonly state: {
    readonly optionsHash: string;
    readonly sessionIdentity: string;
    readonly version: 3;
  };
}> {
  const preparedTemplate = requirePreparedMicrosandboxTemplate(input.artifact, input.providerName);
  const sessionIdentity =
    input.sessionIdentity ??
    createStableHash(
      `${input.context.session.id}:${preparedTemplate.snapshotName}:${input.optionsHash}`,
    ).slice(0, 32);
  const sessionRootPath = resolveMicrosandboxSessionRootPath(
    input.context.storagePath,
    sessionIdentity,
  );
  const metadataPath = resolveMicrosandboxMetadataPath(sessionRootPath);
  const existingState = await readSessionMetadata(metadataPath);
  const image = resolveMicrosandboxImage(existingState, preparedTemplate, input.options);
  const options: LiveMicrosandboxOptions = {
    ...input.options,
    ...image,
    networkPolicy: input.runtimeOptions?.networkPolicy,
  };
  const module = await loadMicrosandboxModule({ host: input.context.host, options });
  const activeSessionKey = createActiveMicrosandboxSessionKey(sessionRootPath, input.optionsHash);
  const activeHandle = activeMicrosandboxSessionHandles.get(activeSessionKey);
  const state = { optionsHash: input.optionsHash, sessionIdentity, version: 3 as const };
  if (activeHandle !== undefined) return { handle: activeHandle, state };

  const sessionTags = withDevelopmentSandboxMetadataPathTag(
    { sessionId: input.context.session.id },
    metadataPath,
  );
  if (
    existingState?.optionsHash === input.optionsHash &&
    ((await sandboxExists(module, existingState.sandboxName)) ||
      (existingState.stateSnapshotName !== undefined &&
        (await snapshotExists(module, existingState.stateSnapshotName))))
  ) {
    const connected = await connectMicrosandbox({
      metadata: existingState,
      metadataPath,
      module,
      options,
      sessionKey: input.context.session.id,
      tags: sessionTags,
    });
    if (connected !== null) {
      return {
        handle: cacheHandle(
          activeSessionKey,
          createHandle(connected, input.optionsHash, () => {
            activeMicrosandboxSessionHandles.delete(activeSessionKey);
          }),
        ),
        state,
      };
    }
  }

  if (input.sessionIdentity !== undefined && input.createIfMissing === false) {
    throw new Error(
      `microsandbox session "${input.sessionIdentity}" is no longer available to resume.`,
    );
  }

  if (
    preparedTemplate.optionsHash !== input.optionsHash ||
    !(await snapshotExists(module, preparedTemplate.snapshotName))
  ) {
    throw new SandboxTemplateNotProvisionedError({
      providerName: input.providerName,
      templateKey: preparedTemplate.snapshotName,
    });
  }
  const sandboxName = createProviderName("eve-sbx-ses", sessionIdentity);
  const sandbox = await createPreparedMicrosandbox({
    fromSnapshot: preparedTemplate.snapshotName,
    module,
    name: sandboxName,
    networkPolicy: options.networkPolicy,
    options,
    sessionKey: input.context.session.id,
    setupBaseRuntime: false,
    tags: sessionTags,
  });
  await sandbox.writeMetadata(metadataPath, input.optionsHash);
  const handle = cacheHandle(
    activeSessionKey,
    createHandle(sandbox, input.optionsHash, () => {
      activeMicrosandboxSessionHandles.delete(activeSessionKey);
    }),
  );
  return { handle, state };
}

function resolveMicrosandboxImage(
  session: Readonly<MicrosandboxSessionMetadata> | null,
  template: MicrosandboxTemplateMetadata | undefined,
  defaults: ResolvedMicrosandboxOptions,
): Pick<ResolvedMicrosandboxOptions, "image" | "pullPolicy"> {
  if (session?.image !== undefined) {
    return { image: session.image, pullPolicy: "always" };
  }
  if (template?.image !== undefined) {
    return { image: template.image, pullPolicy: "always" };
  }
  return { image: defaults.image, pullPolicy: defaults.pullPolicy };
}

function microsandboxTemplateArtifact(
  metadata: MicrosandboxTemplateMetadata,
): MicrosandboxPreparedArtifact {
  return {
    image: metadata.image ?? null,
    optionsHash: metadata.optionsHash,
    snapshotName: metadata.snapshotName,
    version: metadata.version,
  };
}

function requirePreparedMicrosandboxTemplate(
  artifact: SandboxPreparedArtifact,
  providerName: string,
): MicrosandboxTemplateMetadata {
  if (
    !isSandboxPreparedArtifactRecord(artifact) ||
    artifact.version !== MICROSANDBOX_METADATA_VERSION ||
    typeof artifact.optionsHash !== "string" ||
    typeof artifact.snapshotName !== "string"
  ) {
    throw new SandboxTemplateNotProvisionedError({
      providerName,
      templateKey: "invalid-artifact",
    });
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
  _optionsHash: string,
  onShutdown?: () => void,
): SandboxProviderHandle<MutableNetworkSandboxSession> {
  const session = buildSandboxSession(
    createMicrosandboxInternalSession(sandbox),
    async (policy) => {
      await sandbox.setNetworkPolicy(policy);
    },
  );
  return {
    sandbox: session,
    async onSessionDelete() {
      await sandbox.shutdown();
      await sandbox.removePersisted();
      onShutdown?.();
    },
    async onSessionStop() {
      await sandbox.stop();
      onShutdown?.();
    },
    async onRuntimeShutdown() {
      onShutdown?.();
      await sandbox.shutdown();
    },
  };
}

function createMicrosandboxInternalSession(sandbox: MicrosandboxVm): InternalSandboxSession {
  return createFileBackedInternalSandboxSession({ sandbox });
}

function createActiveMicrosandboxSessionKey(sessionRootPath: string, optionsHash: string): string {
  return `${sessionRootPath}\0${optionsHash}`;
}

function cacheHandle(
  key: string,
  handle: SandboxProviderHandle<MutableNetworkSandboxSession>,
): SandboxProviderHandle<MutableNetworkSandboxSession> {
  activeMicrosandboxSessionHandles.set(key, handle);
  return handle;
}

export function clearActiveMicrosandboxSessionHandlesForTest(): void {
  activeMicrosandboxSessionHandles.clear();
}
