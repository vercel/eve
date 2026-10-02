import type { MicrosandboxSandboxSession } from "#public/sandbox/microsandbox.js";
import {
  createMicrosandboxSandboxProvider,
  type MicrosandboxProviderSessionState,
} from "#execution/sandbox/bindings/microsandbox.js";
import type { MicrosandboxPreparedArtifact } from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import type {
  MicrosandboxSandboxCreateOptions,
  MicrosandboxSandboxRuntimeOptions,
} from "#public/sandbox/microsandbox-sandbox.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

export type MicrosandboxEnvironmentOptions = MicrosandboxSandboxCreateOptions;

type DockerfileEnvironmentInput = Omit<MicrosandboxEnvironmentOptions, "image">;

const provider = defineSandboxProvider<
  MicrosandboxEnvironmentOptions,
  MicrosandboxSandboxRuntimeOptions,
  MicrosandboxPreparedArtifact,
  MicrosandboxProviderSessionState,
  MicrosandboxSandboxSession
>({
  name: "microsandbox",
  stateProtocolVersion: 3,
  environment: (options) => createMicrosandboxSandboxProvider(options),
});

export const MicrosandboxSandbox = {
  ...provider,
  dockerfile(
    options: DockerfileEnvironmentInput = {},
  ): SandboxEnvironment<MicrosandboxSandboxRuntimeOptions, MicrosandboxSandboxSession> {
    return provider.environment(options);
  },
  image(
    reference: string,
    options: DockerfileEnvironmentInput = {},
  ): SandboxEnvironment<MicrosandboxSandboxRuntimeOptions, MicrosandboxSandboxSession> {
    return provider.environment({ ...options, image: reference });
  },
};
