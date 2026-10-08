import { setTimeout as sleep } from "node:timers/promises";

import { hydrateSandboxFromImmutableResources } from "#execution/sandbox/bindings/immutable-resources.js";
import { VERCEL_EVE_SANDBOX_IMAGE } from "#execution/sandbox/bindings/eve-image.js";
import {
  createVercelNetworkPolicySetter,
  ensureVercelSandboxBaseRuntime,
} from "#execution/sandbox/bindings/vercel-base-runtime.js";
import type { OciImagePublisher } from "#execution/sandbox/bindings/oci-image-publisher.js";
import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import {
  ensureVercelSandboxTags,
  resolveVercelSandboxTags,
} from "#execution/sandbox/bindings/vercel-options.js";
import {
  isVercelImageUnavailableError,
  isVercelResourceMissingError,
  isVercelResourcePendingError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { deleteVercelSandbox } from "#execution/sandbox/bindings/vercel-lifecycle.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import {
  createVercelInternalSandboxSession,
  createVercelSandboxHandle,
} from "#execution/sandbox/bindings/vercel.js";
import {
  describeVercelImageForks,
  forkVercelImageMounts,
  prepareVercelImageResource,
  type VercelImageForkArtifact,
  type VercelImageMountArtifact,
} from "#execution/sandbox/bindings/vercel-image-resources.js";
import type {
  VercelCreateOptions,
  VercelDrive,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { materializeSandboxDockerfile } from "#execution/sandbox/dockerfile.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import type {
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
} from "#public/sandbox/vercel-image-sandbox.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

type NetworkPolicySandboxSession = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};
import { decodeVercelOidcTokenClaims } from "#shared/vercel-project.js";
import {
  isSandboxPreparedArtifactRecord,
  sandboxProviderResourceIdentity,
  type SandboxDeleteOptions,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
  type SandboxProviderResources,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";

export const VERCEL_IMAGE_PROVIDER_NAME = "vercel-image";
const OCI_REGISTRY = "vcr.vercel.com";
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
const DIGEST_PINNED_IMAGE = /^vcr\.vercel\.com\/.+@sha256:[a-f0-9]{64}$/u;
const EVE_RESOURCE_DRIVE_NAME = /^eve-sbx-res-[a-f0-9]{32}$/u;
const EVE_RESOURCE_FORK_NAME = /^eve-sbx-fork-[a-f0-9]{32}$/u;
const RESOURCE_MOUNT_PATHS = new Set(["/eve/resources/workspace", "/eve/resources/skills"]);

export type VercelImagePreparedArtifact = {
  readonly image: string;
  readonly mounts: readonly VercelImageMountArtifact[];
  readonly version: 1;
};

export interface CreateVercelImageProviderInput {
  readonly createImagePublisher?: (input: {
    readonly authToken: string;
    readonly registry: string;
    readonly username: string;
  }) => OciImagePublisher;
  readonly ensureBaseRuntime?: typeof ensureVercelSandboxBaseRuntime;
  readonly hydrateResources?: typeof hydrateSandboxFromImmutableResources;
  readonly identityPrefix?: string;
  readonly loadDeleteModule?: () => Promise<VercelModule>;
  readonly loadModule?: () => Promise<VercelModule>;
  readonly resolveNativeSession?: (context: SandboxProviderSessionContext) => {
    readonly identity: Readonly<Record<string, string>>;
    readonly tags: Readonly<Record<string, string>>;
  };
  readonly waitForImage?: () => Promise<void>;
}

export type VercelImageSessionState = {
  readonly forks: readonly VercelImageForkArtifact[];
  readonly generation: string;
  readonly sandboxName: string;
  readonly version: 3;
};

export function createVercelImageSandboxProvider(
  environmentOptions: ExperimentalVercelImageEnvironmentOptions | undefined,
  input: CreateVercelImageProviderInput = {},
): SandboxProviderImplementation<
  ExperimentalVercelImageRuntimeOptions,
  VercelImagePreparedArtifact,
  VercelImageSessionState,
  NetworkPolicySandboxSession
> {
  const createImagePublisher = input.createImagePublisher ?? createLazyOciImagePublisher;
  const ensureBaseRuntime = input.ensureBaseRuntime ?? ensureVercelSandboxBaseRuntime;
  const hydrateResources = input.hydrateResources ?? hydrateSandboxFromImmutableResources;
  const identityPrefix = input.identityPrefix ?? VERCEL_IMAGE_PROVIDER_NAME;
  const loadModule =
    input.loadModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const loadDeleteModule =
    input.loadDeleteModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const resolveNativeSession =
    input.resolveNativeSession ??
    ((context) => ({
      identity: { sessionId: context.session.id },
      tags: { sessionId: context.session.id },
    }));
  const waitForImage = input.waitForImage ?? (async () => await sleep(2_000));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...environmentOptions,
  };

  async function deleteForks(
    module: VercelModule,
    forks: readonly VercelImageForkArtifact[],
    signal?: AbortSignal,
  ): Promise<void> {
    const credentials = await getVercelSandboxCredentials(createOptions);
    const fetch = getVercelSandboxFetch(createOptions);
    for (const fork of forks) {
      let drive: VercelDrive;
      try {
        drive = await module.Drive.get({ ...credentials, fetch, name: fork.driveName, signal });
      } catch (error) {
        if (isVercelResourceMissingError(error)) continue;
        throw error;
      }
      try {
        await drive.delete({ signal });
      } catch (error) {
        if (!isVercelResourceMissingError(error)) throw error;
      }
    }
  }

  function createSessionHandle(sandbox: VercelSandbox, forks: readonly VercelImageForkArtifact[]) {
    const handle = createVercelSandboxHandle({
      createOptions,
      loadDeleteSandboxModule: loadDeleteModule,
      sandbox,
    });
    return {
      ...handle,
      async onSandboxDelete(options?: SandboxDeleteOptions) {
        await handle.onSandboxDelete(options);
        await deleteForks(await loadDeleteModule(), forks, options?.abortSignal);
      },
    };
  }

  async function openSession(
    options: Readonly<ExperimentalVercelImageRuntimeOptions> | undefined,
    artifactValue: SandboxPreparedArtifact,
    nativeTags: Readonly<Record<string, string>>,
    sandboxName: string,
  ) {
    const artifact = requirePreparedArtifact(artifactValue);
    const module = await loadModule();
    let sandbox = await getNamedVercelSandbox({
      createOptions,
      sandboxModule: module,
      sandboxName,
    });
    let created = false;
    let forks = describeVercelImageForks(artifact.mounts, sandboxName);
    if (sandbox === null) {
      created = true;
      try {
        const credentials = await getVercelSandboxCredentials(createOptions);
        const forked = await forkVercelImageMounts({
          createOptions,
          module,
          mounts: artifact.mounts,
          sandboxName,
          signal: createOptions.signal,
        });
        forks = forked.forks;
        const {
          image: _image,
          runtime: _runtime,
          source: _source,
          ...imageCreateOptions
        } = createOptions;
        const runtimeOptions = options ?? {};
        sandbox = await createImageSandboxWithRetry({
          create: async () =>
            await module.Sandbox.create({
              ...imageCreateOptions,
              ...runtimeOptions,
              ...credentials,
              fetch: getVercelSandboxFetch(createOptions),
              image: artifact.image,
              mounts: forked.mounts,
              name: sandboxName,
              persistent: true,
              tags: resolveVercelSandboxTags(createOptions.tags, nativeTags),
            }),
          wait: waitForImage,
        });
      } catch (error) {
        if (isVercelImageUnavailableError(error) || isVercelResourcePendingError(error)) {
          throw new SandboxTemplateNotProvisionedError({
            providerName: VERCEL_IMAGE_PROVIDER_NAME,
            templateKey: artifact.image,
          });
        }
        throw error;
      }
      const session = buildSandboxSession(
        createVercelInternalSandboxSession(sandbox),
        createVercelNetworkPolicySetter(sandbox),
      );
      try {
        await ensureBaseRuntime(sandbox);
        await hydrateResources(session);
      } catch (error) {
        try {
          await sandbox.delete({ signal: createOptions.signal });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Failed to hydrate and discard sandbox.",
            {
              cause: error,
            },
          );
        }
        throw error;
      }
    } else {
      await ensureBaseRuntime(sandbox);
      await ensureVercelSandboxTags(
        sandbox,
        resolveVercelSandboxTags(createOptions.tags, nativeTags),
      );
    }
    return {
      created,
      forks,
      handle: createSessionHandle(sandbox, forks),
    };
  }

  return {
    async onSessionEnd(_context, artifact, stateValue) {
      const prepared = requirePreparedArtifact(artifact);
      const state = requireSessionState(stateValue, prepared);
      if (state.generation !== imageGeneration(artifact, createOptions)) {
        throw new Error(
          "Vercel image sandbox session state is incompatible with this environment.",
        );
      }
      const module = await loadDeleteModule();
      const sandbox = await getNamedVercelSandbox({
        createOptions,
        sandboxModule: module,
        sandboxName: state.sandboxName,
      });
      if (sandbox !== null) {
        await deleteVercelSandbox({
          createOptions,
          loadDeleteSandboxModule: async () => module,
          sandbox,
          signal: createOptions.signal,
        });
      }

      await deleteForks(module, state.forks, createOptions.signal);
    },
    async prepare(context) {
      const dockerfile = await materializeSandboxDockerfile({
        files: context.files,
        storagePath: context.storagePath,
      });
      const image =
        dockerfile === undefined
          ? VERCEL_EVE_SANDBOX_IMAGE
          : await publishDockerfileImage({
              createImagePublisher,
              createOptions,
              dockerfile,
              environmentOptions,
              resources: context.resources,
            });
      const module = await loadModule();
      const preparedMounts = await Promise.all(
        [context.resources.workspace, context.resources.skills]
          .filter((resource) => resource !== undefined)
          .map(
            async (resource) =>
              await prepareVercelImageResource({
                createOptions,
                module,
                resource,
                signal: createOptions.signal,
              }),
          ),
      );
      return { image, mounts: preparedMounts, version: 1 };
    },
    async resume(_context, artifact, stateValue) {
      const prepared = requirePreparedArtifact(artifact);
      const state = requireSessionState(stateValue, prepared);
      if (state.generation !== imageGeneration(artifact, createOptions)) {
        throw new Error(
          "Vercel image sandbox session state is incompatible with this environment.",
        );
      }
      const module = await loadModule();
      const sandbox = await getNamedVercelSandbox({
        createOptions,
        sandboxModule: module,
        sandboxName: state.sandboxName,
      });
      if (sandbox === null) {
        throw new Error(`Vercel image sandbox session "${state.sandboxName}" no longer exists.`);
      }
      await ensureBaseRuntime(sandbox);
      return createSessionHandle(sandbox, state.forks);
    },
    async start(context, options, artifact) {
      const nativeSession = resolveNativeSession(context);
      const sandboxName = sessionName(identityPrefix, nativeSession.identity, options, artifact);
      const result = await openSession(options, artifact, nativeSession.tags, sandboxName);
      return {
        handle: result.handle,
        state: {
          forks: result.forks,
          generation: imageGeneration(artifact, createOptions),
          sandboxName,
          version: 3,
        },
      };
    },
  };
}

async function publishDockerfileImage(input: {
  readonly createImagePublisher: NonNullable<
    CreateVercelImageProviderInput["createImagePublisher"]
  >;
  readonly createOptions: VercelCreateOptions;
  readonly dockerfile: NonNullable<Awaited<ReturnType<typeof materializeSandboxDockerfile>>>;
  readonly environmentOptions: ExperimentalVercelImageEnvironmentOptions | undefined;
  readonly resources: SandboxProviderResources;
}): Promise<string> {
  const credentials = await getVercelSandboxCredentials(input.createOptions);
  const imageReference = resolveImageReference(
    credentials,
    createSandboxProviderIdentity({
      dockerfile: input.dockerfile.contentHash,
      environment: input.environmentOptions,
      resources: sandboxProviderResourceIdentity(input.resources),
      version: 1,
    }),
  );
  return await input
    .createImagePublisher({
      authToken: credentials.token,
      registry: OCI_REGISTRY,
      username: credentials.teamId,
    })
    .publish({
      dockerfile: input.dockerfile,
      imageReference,
      signal: input.createOptions.signal,
    });
}

function vercelImageIdentityOptions(options: object): object {
  const excluded = new Set(["fetch", "projectId", "signal", "teamId", "token"]);
  return Object.fromEntries(Object.entries(options).filter(([key]) => !excluded.has(key)));
}

function imageGeneration(
  artifact: SandboxPreparedArtifact,
  createOptions: VercelCreateOptions,
): string {
  return createSandboxProviderIdentity({
    artifact: requirePreparedArtifact(artifact),
    environment: vercelImageIdentityOptions(createOptions),
    version: 1,
  });
}

function sessionName(
  identityPrefix: string,
  nativeSessionIdentity: Readonly<Record<string, string>>,
  options: Readonly<ExperimentalVercelImageRuntimeOptions> | undefined,
  artifact: SandboxPreparedArtifact,
): string {
  return `eve-sbx-${identityPrefix}-${createSandboxProviderIdentity({
    artifact: requirePreparedArtifact(artifact),
    options: { networkPolicy: options?.networkPolicy, resources: options?.resources },
    nativeSessionIdentity,
    version: 1,
  }).slice(0, 32)}`;
}

function requireSessionState(
  state: unknown,
  artifact: VercelImagePreparedArtifact,
): VercelImageSessionState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 3 ||
    typeof state.generation !== "string" ||
    typeof state.sandboxName !== "string" ||
    !Array.isArray(state.forks) ||
    !state.forks.every(isForkArtifact)
  ) {
    throw new Error("Invalid Vercel image sandbox session state.");
  }
  const expected = describeVercelImageForks(artifact.mounts, state.sandboxName);
  if (
    state.forks.length !== expected.length ||
    state.forks.some((fork, index) => {
      const expectedFork = expected[index];
      return (
        expectedFork === undefined ||
        fork.driveName !== expectedFork.driveName ||
        fork.mountPath !== expectedFork.mountPath ||
        fork.resourceKey !== expectedFork.resourceKey ||
        fork.sourceDriveName !== expectedFork.sourceDriveName
      );
    })
  ) {
    throw new Error("Vercel image sandbox session Drive state is incompatible.");
  }
  return {
    forks: state.forks,
    generation: state.generation,
    sandboxName: state.sandboxName,
    version: 3,
  };
}

async function createImageSandboxWithRetry<T>(input: {
  readonly create: () => Promise<T>;
  readonly wait: () => Promise<void>;
}): Promise<T> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      return await input.create();
    } catch (error) {
      if (!isVercelResourcePendingError(error) || attempt === 44) throw error;
      await input.wait();
    }
  }
  throw new Error("Vercel image readiness retry exhausted unexpectedly.");
}

function createLazyOciImagePublisher(input: {
  readonly authToken: string;
  readonly registry: string;
  readonly username: string;
}): OciImagePublisher {
  return {
    async publish(publishInput) {
      const { createOciImagePublisher } =
        await import("#execution/sandbox/bindings/oci-image-publisher.js");
      return await createOciImagePublisher(input).publish(publishInput);
    },
  };
}

function requirePreparedArtifact(artifact: SandboxPreparedArtifact): VercelImagePreparedArtifact {
  if (
    !isSandboxPreparedArtifactRecord(artifact) ||
    artifact.version !== 1 ||
    typeof artifact.image !== "string" ||
    (artifact.image !== VERCEL_EVE_SANDBOX_IMAGE && !DIGEST_PINNED_IMAGE.test(artifact.image)) ||
    !Array.isArray(artifact.mounts) ||
    !artifact.mounts.every(isMountArtifact) ||
    new Set(artifact.mounts.map((mount) => mount.mountPath)).size !== artifact.mounts.length
  ) {
    throw new Error("Invalid prepared Vercel image artifact.");
  }
  return {
    image: artifact.image,
    mounts: artifact.mounts.map((mount) => ({
      driveName: mount.driveName,
      mountPath: mount.mountPath,
      region: mount.region,
      resourceKey: mount.resourceKey,
    })),
    version: 1,
  };
}

function isForkArtifact(value: SandboxPreparedArtifact): value is VercelImageForkArtifact {
  return (
    isSandboxPreparedArtifactRecord(value) &&
    typeof value.driveName === "string" &&
    EVE_RESOURCE_FORK_NAME.test(value.driveName) &&
    typeof value.mountPath === "string" &&
    RESOURCE_MOUNT_PATHS.has(value.mountPath) &&
    typeof value.resourceKey === "string" &&
    value.resourceKey.length > 0 &&
    typeof value.sourceDriveName === "string" &&
    EVE_RESOURCE_DRIVE_NAME.test(value.sourceDriveName)
  );
}

function isMountArtifact(value: SandboxPreparedArtifact): value is VercelImageMountArtifact {
  return (
    isSandboxPreparedArtifactRecord(value) &&
    typeof value.driveName === "string" &&
    EVE_RESOURCE_DRIVE_NAME.test(value.driveName) &&
    typeof value.mountPath === "string" &&
    typeof value.region === "string" &&
    value.region.length > 0 &&
    typeof value.resourceKey === "string" &&
    value.resourceKey.length > 0 &&
    RESOURCE_MOUNT_PATHS.has(value.mountPath)
  );
}

function resolveImageReference(
  credentials: Awaited<ReturnType<typeof getVercelSandboxCredentials>>,
  artifactIdentity: string,
): string {
  const claims = decodeVercelOidcTokenClaims(credentials.token);
  if (claims.ownerId !== credentials.teamId || claims.projectId !== credentials.projectId) {
    throw new Error("The Vercel credentials do not match the active image scope.");
  }
  const scope = readImageScope(credentials.token);
  const tag = createSandboxProviderIdentity(artifactIdentity).slice(0, 24);
  return `${OCI_REGISTRY}/${scope.owner}/${scope.project}/eve-sandbox:${tag}`;
}

function readImageScope(token: string): { readonly owner: string; readonly project: string } {
  const segment = token.split(".")[1];
  if (segment === undefined)
    throw new Error("The Vercel credentials do not identify an image scope.");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new Error("The Vercel credentials do not identify an image scope.");
  }
  if (value === null || typeof value !== "object") {
    throw new Error("The Vercel credentials do not identify an image scope.");
  }
  const owner = Reflect.get(value, "owner");
  const project = Reflect.get(value, "project");
  if (typeof owner !== "string" || typeof project !== "string") {
    throw new Error("The Vercel credentials do not identify an image scope.");
  }
  return { owner: sanitizeScope(owner), project: sanitizeScope(project) };
}

function sanitizeScope(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(normalized)) {
    throw new Error("The Vercel image scope is invalid.");
  }
  return normalized;
}
