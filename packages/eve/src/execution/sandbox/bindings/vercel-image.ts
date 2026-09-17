import { setTimeout as sleep } from "node:timers/promises";

import { hydrateSandboxFromImmutableResources } from "#execution/sandbox/bindings/immutable-resources.js";
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
  isVercelResourcePendingError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import {
  createVercelInternalSandboxSession,
  createVercelSandboxHandle,
} from "#execution/sandbox/bindings/vercel.js";
import {
  createVercelImageResourcePublisher,
  VercelImageResourceUnavailableError,
  type VercelImageMountArtifact,
  type VercelImageResourcePublisher,
} from "#execution/sandbox/bindings/vercel-image-resources.js";
import type {
  VercelCreateOptions,
  VercelModule,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { materializeSandboxDockerfile } from "#execution/sandbox/dockerfile.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import type {
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
} from "#public/sandbox/vercel-image-sandbox.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type { MutableNetworkSandboxSession } from "#shared/sandbox-session.js";
import { decodeVercelOidcTokenClaims } from "#shared/vercel-project.js";
import {
  isSandboxPreparedArtifactRecord,
  sandboxProviderResourceIdentity,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
} from "#shared/sandbox-provider.js";

export const VERCEL_IMAGE_PROVIDER_NAME = "vercel-image";
const OCI_REGISTRY = "vcr.vercel.com";
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
const DIGEST_PINNED_IMAGE = /^vcr\.vercel\.com\/.+@sha256:[a-f0-9]{64}$/u;
const EVE_RESOURCE_DRIVE_NAME = /^eve-sbx-res-[a-f0-9]{32}$/u;
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
  readonly resolveNativeSession?: (
    context: import("#shared/sandbox-provider.js").SandboxProviderSessionContext,
  ) => {
    readonly identity: Readonly<Record<string, string>>;
    readonly tags: Readonly<Record<string, string>>;
  };
  readonly resourcePublisher?: VercelImageResourcePublisher;
  readonly waitForImage?: () => Promise<void>;
}

export type VercelImageSessionState = {
  readonly generation: string;
  readonly sandboxName: string;
  readonly version: 2;
};

export function createVercelImageSandboxProvider(
  environmentOptions: ExperimentalVercelImageEnvironmentOptions | undefined,
  input: CreateVercelImageProviderInput = {},
): SandboxProviderImplementation<
  ExperimentalVercelImageRuntimeOptions,
  VercelImagePreparedArtifact,
  VercelImageSessionState,
  MutableNetworkSandboxSession
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
  const resourcePublisher =
    input.resourcePublisher ?? createVercelImageResourcePublisher({ loadModule });
  const waitForImage = input.waitForImage ?? (async () => await sleep(2_000));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...environmentOptions,
  };

  async function openSession(
    context: import("#shared/sandbox-provider.js").SandboxProviderSessionContext,
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
    if (sandbox === null) {
      created = true;
      try {
        const credentials = await getVercelSandboxCredentials(createOptions);
        const mounts = await resourcePublisher.resolveMounts({
          createOptions,
          mounts: artifact.mounts,
          signal: createOptions.signal,
        });
        const {
          image: _image,
          runtime: _runtime,
          source: _source,
          ...imageCreateOptions
        } = createOptions;
        const { onSession: _onSession, ...runtimeOptions } = options ?? {};
        sandbox = await createImageSandboxWithRetry({
          create: async () =>
            await module.Sandbox.create({
              ...imageCreateOptions,
              ...runtimeOptions,
              ...credentials,
              fetch: getVercelSandboxFetch(createOptions),
              image: artifact.image,
              mounts,
              name: sandboxName,
              persistent: true,
              tags: resolveVercelSandboxTags(createOptions.tags, nativeTags),
            }),
          wait: waitForImage,
        });
      } catch (error) {
        if (
          error instanceof VercelImageResourceUnavailableError ||
          isVercelImageUnavailableError(error) ||
          isVercelResourcePendingError(error)
        ) {
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
        await options?.onSession?.({ sandbox: session, session: context.session });
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
      handle: createVercelSandboxHandle({
        createOptions,
        loadDeleteSandboxModule: loadDeleteModule,
        sandbox,
      }),
    };
  }

  return {
    async prepare(context) {
      const dockerfile = await materializeSandboxDockerfile({
        files: context.files,
        storagePath: context.storagePath,
      });
      if (dockerfile === undefined) {
        throw new Error("The Vercel image environment requires agent/sandbox/Dockerfile.");
      }
      const credentials = await getVercelSandboxCredentials(createOptions);
      const imageReference = resolveImageReference(
        credentials,
        createSandboxProviderIdentity({
          dockerfile: dockerfile.contentHash,
          environment: environmentOptions,
          resources: sandboxProviderResourceIdentity(context.resources),
          version: 1,
        }),
      );
      const image = await createImagePublisher({
        authToken: credentials.token,
        registry: OCI_REGISTRY,
        username: credentials.teamId,
      }).publish({ dockerfile, imageReference, signal: createOptions.signal });
      const preparedMounts = await Promise.all(
        [context.resources.workspace, context.resources.skills]
          .filter((resource) => resource !== undefined)
          .map((resource) =>
            resourcePublisher.prepare({
              createOptions,
              resource,
              signal: createOptions.signal,
            }),
          ),
      );
      return { image, mounts: preparedMounts.map((mount) => mount.artifact), version: 1 };
    },
    async resume(_context, artifact, stateValue) {
      const state = requireSessionState(stateValue);
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
      return createVercelSandboxHandle({
        createOptions,
        loadDeleteSandboxModule: loadDeleteModule,
        sandbox,
      });
    },
    async start(context, options, artifact) {
      const nativeSession = resolveNativeSession(context);
      const sandboxName = sessionName(identityPrefix, nativeSession.identity, options, artifact);
      const result = await openSession(context, options, artifact, nativeSession.tags, sandboxName);
      return {
        handle: result.handle,
        state: { generation: imageGeneration(artifact, createOptions), sandboxName, version: 2 },
      };
    },
  };
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

function requireSessionState(state: unknown): VercelImageSessionState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 2 ||
    typeof state.generation !== "string" ||
    typeof state.sandboxName !== "string"
  ) {
    throw new Error("Invalid Vercel image sandbox session state.");
  }
  return { generation: state.generation, sandboxName: state.sandboxName, version: 2 };
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
    !DIGEST_PINNED_IMAGE.test(artifact.image) ||
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
