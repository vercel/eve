import type { NetworkPolicySandboxSession } from "#public/sandbox/network-policy-session.js";
import { enrichMicrosandboxError } from "#execution/sandbox/bindings/microsandbox-create.js";
import {
  createMicrosandboxHandle,
  type MicrosandboxPreparedArtifact,
  prewarmMicrosandboxTemplate,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import {
  microsandboxOptionsForHash,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import { createStableHash } from "#execution/sandbox/bindings/microsandbox-runtime.js";
import { materializeSandboxDockerfile } from "#execution/sandbox/dockerfile.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import type {
  MicrosandboxSandboxCreateOptions,
  MicrosandboxSandboxRuntimeOptions,
} from "#public/sandbox/microsandbox-sandbox.js";
import {
  isSandboxPreparedArtifactRecord,
  sandboxProviderResourceIdentity,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
} from "#shared/sandbox-provider.js";

export { pruneMicrosandboxTemplates } from "#execution/sandbox/bindings/microsandbox-templates.js";

export const MICROSANDBOX_PROVIDER_NAME = "microsandbox";

export type MicrosandboxProviderSessionState = {
  readonly optionsHash: string;
  readonly sessionIdentity: string;
  readonly version: 3;
};

export function createMicrosandboxSandboxProvider(
  authoredOptions: MicrosandboxSandboxCreateOptions | undefined = undefined,
): SandboxProviderImplementation<
  MicrosandboxSandboxRuntimeOptions,
  MicrosandboxPreparedArtifact,
  MicrosandboxProviderSessionState,
  NetworkPolicySandboxSession
> {
  const createOptions = authoredOptions ?? {};
  const options = resolveMicrosandboxOptions(createOptions);
  const optionsHash = createStableHash(JSON.stringify(microsandboxOptionsForHash(options))).slice(
    0,
    20,
  );

  return {
    async prepare(context) {
      const dockerfile = await materializeSandboxDockerfile({
        files: context.files,
        storagePath: context.storagePath,
      });
      const templateKey = createSandboxProviderIdentity({
        dockerfile: dockerfile?.contentHash,
        optionsHash,
        resources: sandboxProviderResourceIdentity(context.resources),
        sourceRevision: context.sourceRevision,
        version: 2,
      }).slice(0, 24);
      try {
        return await prewarmMicrosandboxTemplate({
          context,
          dockerfile,
          options,
          optionsHash,
          prepare: createOptions.prepare,
          providerName: MICROSANDBOX_PROVIDER_NAME,
          templateKey,
        });
      } catch (error) {
        throw enrichMicrosandboxError({ context: "Failed to prepare microsandbox", error });
      }
    },
    async resume(context, artifactValue, stateValue) {
      const artifact = requireArtifact(artifactValue);
      const state = requireState(stateValue);
      if (
        state.optionsHash !== optionsHash ||
        artifact.optionsHash !== optionsHash ||
        state.sessionIdentity !==
          microsandboxSessionIdentity(context.session.id, artifact, optionsHash)
      ) {
        throw new Error("microsandbox session state is incompatible with this environment.");
      }
      const result = await createMicrosandboxHandle({
        artifact,
        context,
        createIfMissing: false,
        sessionIdentity: state.sessionIdentity,
        options,
        optionsHash,
        providerName: MICROSANDBOX_PROVIDER_NAME,
      });
      return result.handle;
    },
    async start(context, runtimeOptions, artifactValue) {
      const artifact = requireArtifact(artifactValue);
      const result = await createMicrosandboxHandle({
        artifact,
        context,
        options,
        optionsHash,
        providerName: MICROSANDBOX_PROVIDER_NAME,
        runtimeOptions,
      });
      return result;
    },
  };
}

function microsandboxSessionIdentity(
  sessionId: string,
  artifact: MicrosandboxPreparedArtifact,
  optionsHash: string,
): string {
  const identity = createStableHash(`${sessionId}:${artifact.snapshotName}:${optionsHash}`).slice(
    0,
    32,
  );
  return identity;
}

function requireArtifact(artifact: SandboxPreparedArtifact): MicrosandboxPreparedArtifact {
  if (
    !isSandboxPreparedArtifactRecord(artifact) ||
    artifact.version !== 2 ||
    typeof artifact.optionsHash !== "string" ||
    typeof artifact.snapshotName !== "string"
  ) {
    throw new Error("Invalid prepared microsandbox artifact.");
  }
  return {
    image: typeof artifact.image === "string" ? artifact.image : null,
    optionsHash: artifact.optionsHash,
    snapshotName: artifact.snapshotName,
    version: 2,
  };
}

function requireState(state: unknown): MicrosandboxProviderSessionState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 3 ||
    typeof state.optionsHash !== "string" ||
    typeof state.sessionIdentity !== "string"
  ) {
    throw new Error("Invalid microsandbox session state.");
  }
  return {
    optionsHash: state.optionsHash,
    sessionIdentity: state.sessionIdentity,
    version: 3,
  };
}
