import type { MutableNetworkSandboxSession } from "#shared/sandbox-session.js";
import { enrichMicrosandboxError } from "#execution/sandbox/bindings/microsandbox-create.js";
import {
  createMicrosandboxHandle,
  type MicrosandboxPreparedArtifact,
  prewarmMicrosandboxTemplate,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import type { MicrosandboxSessionMetadata } from "#execution/sandbox/bindings/microsandbox-metadata.js";
import {
  microsandboxOptionsForHash,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import {
  createProviderName,
  createStableHash,
} from "#execution/sandbox/bindings/microsandbox-runtime.js";
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

export type MicrosandboxProviderSessionState = MicrosandboxSessionMetadata;

export function createMicrosandboxSandboxProvider(
  authoredOptions: MicrosandboxSandboxCreateOptions | undefined = undefined,
): SandboxProviderImplementation<
  MicrosandboxSandboxRuntimeOptions,
  MicrosandboxPreparedArtifact,
  MicrosandboxProviderSessionState,
  MutableNetworkSandboxSession
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
        prepare: createOptions.prepare,
        resources: sandboxProviderResourceIdentity(context.resources),
        version: 1,
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
        state.sandboxName !== microsandboxSessionName(context.session.id, artifact, optionsHash)
      ) {
        throw new Error("microsandbox session state is incompatible with this environment.");
      }
      const result = await createMicrosandboxHandle({
        artifact,
        context,
        createIfMissing: false,
        existingState: state,
        options,
        optionsHash,
        providerName: MICROSANDBOX_PROVIDER_NAME,
        runtimeOptions: { networkPolicy: state.networkPolicy },
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

function microsandboxSessionName(
  sessionId: string,
  artifact: MicrosandboxPreparedArtifact,
  optionsHash: string,
): string {
  const identity = createStableHash(`${sessionId}:${artifact.snapshotName}:${optionsHash}`).slice(
    0,
    32,
  );
  return createProviderName("eve-sbx-ses", identity);
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
    state.version !== 2 ||
    typeof state.optionsHash !== "string" ||
    typeof state.sandboxName !== "string"
  ) {
    throw new Error("Invalid microsandbox session state.");
  }
  return {
    image: typeof state.image === "string" ? state.image : undefined,
    optionsHash: state.optionsHash,
    sandboxName: state.sandboxName,
    stateSnapshotName:
      typeof state.stateSnapshotName === "string" ? state.stateSnapshotName : undefined,
    version: 2,
  };
}
