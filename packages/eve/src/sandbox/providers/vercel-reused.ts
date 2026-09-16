import {
  createVercelReusedImageSandboxProvider,
  VERCEL_REUSED_IMAGE_PROVIDER_NAME,
} from "#execution/sandbox/bindings/vercel-reused.js";
import type {
  VercelImagePreparedArtifact,
  VercelImageSessionState,
} from "#execution/sandbox/bindings/vercel-image.js";
import type { ExperimentalVercelReusedImageEnvironmentOptions } from "#public/sandbox/vercel-reused-sandbox.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

const provider = defineSandboxProvider<
  ExperimentalVercelReusedImageEnvironmentOptions | undefined,
  undefined,
  VercelImagePreparedArtifact,
  VercelImageSessionState
>({
  name: VERCEL_REUSED_IMAGE_PROVIDER_NAME,
  environment: (options) => createVercelReusedImageSandboxProvider(options),
});

export const ExperimentalVercelReusedDockerfile = {
  name: VERCEL_REUSED_IMAGE_PROVIDER_NAME,
  environment(
    options?: ExperimentalVercelReusedImageEnvironmentOptions,
  ): SandboxEnvironment<undefined> {
    return provider.environment(options);
  },
};
