import {
  createVercelImageSandboxProvider,
  type CreateVercelImageProviderInput,
  type VercelImagePreparedArtifact,
  type VercelImageSessionState,
} from "#execution/sandbox/bindings/vercel-image.js";
import type { ExperimentalVercelImageRuntimeOptions } from "#public/sandbox/vercel-image-sandbox.js";
import type { ExperimentalVercelReusedImageEnvironmentOptions } from "#public/sandbox/vercel-reused-sandbox.js";
import type {
  SandboxProviderHandle,
  SandboxProviderImplementation,
} from "#shared/sandbox-provider.js";

export const VERCEL_REUSED_IMAGE_PROVIDER_NAME = "vercel-reused-image";

export function createVercelReusedImageSandboxProvider(
  environmentOptions: ExperimentalVercelReusedImageEnvironmentOptions | undefined,
  input: CreateVercelImageProviderInput = {},
): SandboxProviderImplementation<undefined, VercelImagePreparedArtifact, VercelImageSessionState> {
  const underlying = createVercelImageSandboxProvider(
    { region: environmentOptions?.region },
    {
      ...input,
      identityPrefix: VERCEL_REUSED_IMAGE_PROVIDER_NAME,
      resolveNativeSession: () => ({ identity: {}, tags: {} }),
    },
  );
  const runtimeOptions: ExperimentalVercelImageRuntimeOptions = {
    networkPolicy: environmentOptions?.networkPolicy,
    resources: environmentOptions?.resources,
    timeout: environmentOptions?.timeout,
  };

  return {
    prepare: underlying.prepare,
    async resume(context, _options, artifact, state) {
      return reusedHandle(await underlying.resume(context, runtimeOptions, artifact, state));
    },
    async start(context, _options, artifact) {
      const result = await underlying.start(context, runtimeOptions, artifact);
      return { handle: reusedHandle(result.handle), state: result.state };
    },
  };
}

function reusedHandle(handle: SandboxProviderHandle): SandboxProviderHandle {
  const { setNetworkPolicy: _setNetworkPolicy, ...sandbox } = handle.sandbox;
  return {
    sandbox,
    onRuntimeShutdown: preserveReusedCompute,
    onSessionDelete: preserveReusedCompute,
    onSessionStop: preserveReusedCompute,
  };
}

async function preserveReusedCompute(): Promise<void> {}
