import { createHash } from "node:crypto";

import { hydrateSandboxFromImmutableResources } from "#execution/sandbox/bindings/immutable-resources.js";
import { createVercelNetworkPolicySetter } from "#execution/sandbox/bindings/vercel-base-runtime.js";
import type { OciImagePublisher } from "#execution/sandbox/bindings/oci-image-publisher.js";
import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import {
  ensureVercelSandboxTags,
  resolveVercelSandboxTags,
} from "#execution/sandbox/bindings/vercel-options.js";
import { isVercelImageUnavailableError } from "#execution/sandbox/bindings/vercel-errors.js";
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
  VercelDeleteModule,
  VercelModule,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import type {
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
} from "#public/sandbox/vercel-image-sandbox.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { decodeVercelOidcTokenClaims } from "#shared/vercel-project.js";
import {
  isSandboxPreparedArtifactRecord,
  type NoSandboxProviderMetadata,
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
  readonly hydrateResources?: typeof hydrateSandboxFromImmutableResources;
  readonly loadDeleteModule?: () => Promise<VercelDeleteModule>;
  readonly loadModule?: () => Promise<VercelModule>;
  readonly resourcePublisher?: VercelImageResourcePublisher;
}

export function createVercelImageSandboxProvider(
  environmentOptions: ExperimentalVercelImageEnvironmentOptions,
  input: CreateVercelImageProviderInput = {},
): SandboxProviderImplementation<
  ExperimentalVercelImageRuntimeOptions,
  NoSandboxProviderMetadata,
  VercelImagePreparedArtifact
> {
  const createImagePublisher = input.createImagePublisher ?? createLazyOciImagePublisher;
  const hydrateResources = input.hydrateResources ?? hydrateSandboxFromImmutableResources;
  const loadModule =
    input.loadModule ?? (async () => await import("#compiled/@vercel/sandbox-drives/index.js"));
  const loadDeleteModule =
    input.loadDeleteModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const resourcePublisher =
    input.resourcePublisher ?? createVercelImageResourcePublisher({ loadModule });
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...environmentOptions,
  };

  return {
    async prepare(context) {
      if (context.dockerfile === undefined) {
        throw new Error("The Vercel image environment requires agent/sandbox/Dockerfile.");
      }
      if (context.hasPreparation) {
        throw new Error(
          "The Vercel image environment does not support prepare. Put immutable setup in agent/sandbox/Dockerfile.",
        );
      }
      const credentials = await getVercelSandboxCredentials(createOptions);
      const imageReference = resolveImageReference(credentials, context.templateName);
      const image = await createImagePublisher({
        authToken: credentials.token,
        registry: OCI_REGISTRY,
        username: credentials.teamId,
      }).publish({
        dockerfile: context.dockerfile,
        imageReference,
        signal: createOptions.signal,
      });
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
      return {
        artifact: {
          image,
          mounts: preparedMounts.map((mount) => mount.artifact),
          version: 1,
        },
        reused: false,
      };
    },
    async getOrCreate(context, source) {
      const artifact = requirePreparedArtifact(source, context.session.name);
      const module = await loadModule();
      const tags = resolveVercelSandboxTags(createOptions.tags, context.tags);
      let sandbox = await getNamedVercelSandbox({
        createOptions,
        sandboxModule: module,
        sandboxName: context.session.name,
      });
      if (sandbox === null) {
        if (source.kind !== "prepared") {
          throw new Error(
            `Sandbox session "${context.session.name}" requires a prepared artifact.`,
          );
        }
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
          sandbox = await module.Sandbox.create({
            ...imageCreateOptions,
            ...context.options,
            ...credentials,
            fetch: getVercelSandboxFetch(createOptions),
            image: artifact.image,
            mounts,
            name: context.session.name,
            persistent: true,
            tags,
          });
        } catch (error) {
          if (
            error instanceof VercelImageResourceUnavailableError ||
            isVercelImageUnavailableError(error)
          ) {
            throw new SandboxTemplateNotProvisionedError({
              providerName: VERCEL_IMAGE_PROVIDER_NAME,
              templateKey: source.templateName,
            });
          }
          throw error;
        }
        const session = buildSandboxSession(
          createVercelInternalSandboxSession(sandbox, context.session.name),
          createVercelNetworkPolicySetter(sandbox),
        );
        try {
          await hydrateResources(session);
        } catch (error) {
          try {
            await sandbox.delete({ signal: createOptions.signal });
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Failed to hydrate and discard sandbox session "${context.session.name}".`,
              { cause: error },
            );
          }
          throw error;
        }
      } else {
        const expectedConfig = tags?.sandboxConfig;
        if (expectedConfig !== undefined && sandbox.tags?.sandboxConfig !== expectedConfig) {
          throw new Error(
            `Named sandbox "${context.session.name}" was requested with conflicting configuration.`,
          );
        }
        await ensureVercelSandboxTags(sandbox, tags);
      }
      return createVercelSandboxHandle({
        createOptions,
        loadDeleteSandboxModule: loadDeleteModule,
        sandbox,
        sessionKey: context.session.name,
      });
    },
  };
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

function requirePreparedArtifact(
  source:
    | { readonly kind: "base" }
    | {
        readonly artifact: VercelImagePreparedArtifact;
        readonly kind: "prepared";
        readonly templateName: string;
      },
  sessionName: string,
): VercelImagePreparedArtifact {
  if (source.kind === "base") {
    throw new Error(`Sandbox session "${sessionName}" requires a prepared Vercel image artifact.`);
  }
  const artifact: SandboxPreparedArtifact = source.artifact;
  if (
    !isSandboxPreparedArtifactRecord(artifact) ||
    artifact.version !== 1 ||
    typeof artifact.image !== "string" ||
    !DIGEST_PINNED_IMAGE.test(artifact.image) ||
    !Array.isArray(artifact.mounts) ||
    !artifact.mounts.every(isMountArtifact) ||
    new Set(artifact.mounts.map((mount) => mount.mountPath)).size !== artifact.mounts.length
  ) {
    throw new Error(
      `Invalid prepared Vercel image artifact for template "${source.templateName}".`,
    );
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
  templateName: string,
): string {
  const claims = decodeVercelOidcTokenClaims(credentials.token);
  if (claims.ownerId !== credentials.teamId || claims.projectId !== credentials.projectId) {
    throw new Error("The Vercel credentials do not match the active image scope.");
  }
  const scope = readImageScope(credentials.token);
  const tag = createHash("sha256").update(templateName).digest("hex").slice(0, 24);
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
