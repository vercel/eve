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

const provider = defineSandboxProvider<
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
  VercelImagePreparedArtifact,
  VercelImageSessionState
>({
  name: VERCEL_IMAGE_PROVIDER_NAME,
  environment: (options) => createVercelImageSandboxProvider(options),
});

export const ExperimentalVercelDockerfile = {
  name: VERCEL_IMAGE_PROVIDER_NAME,
  environment(
    options: ExperimentalVercelImageEnvironmentOptions = {},
  ): SandboxEnvironment<ExperimentalVercelImageRuntimeOptions> {
    return provider.environment(options);
  },
};
