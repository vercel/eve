import {
  createVercelImageSandboxProvider,
  type VercelImagePreparedArtifact,
  type VercelImageSessionState,
  VERCEL_IMAGE_PROVIDER_NAME,
} from "#execution/sandbox/bindings/vercel-image.js";
import type {
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
} from "#public/sandbox/vercel-image-sandbox.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { MutableNetworkSandboxSession } from "#shared/sandbox-session.js";

const provider = defineSandboxProvider<
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
  VercelImagePreparedArtifact,
  VercelImageSessionState,
  MutableNetworkSandboxSession
>({
  name: VERCEL_IMAGE_PROVIDER_NAME,
  environment: (options) => createVercelImageSandboxProvider(options),
});

export const ExperimentalVercelDockerfile = {
  name: VERCEL_IMAGE_PROVIDER_NAME,
  environment(
    options: ExperimentalVercelImageEnvironmentOptions = {},
  ): SandboxEnvironment<ExperimentalVercelImageRuntimeOptions, MutableNetworkSandboxSession> {
    return provider.environment(options);
  },
};
