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
import type { NetworkPolicySandboxSession } from "#shared/sandbox-session.js";

export type MicrosandboxEnvironmentOptions = MicrosandboxSandboxCreateOptions;

type DockerfileEnvironmentInput = Omit<MicrosandboxEnvironmentOptions, "image">;

const provider = defineSandboxProvider<
  MicrosandboxEnvironmentOptions,
  MicrosandboxSandboxRuntimeOptions,
  MicrosandboxPreparedArtifact,
  MicrosandboxProviderSessionState,
  NetworkPolicySandboxSession
>({
  name: "microsandbox",
  stateProtocolVersion: 3,
  environment: (options) => createMicrosandboxSandboxProvider(options),
});

export const MicrosandboxSandbox = {
  ...provider,
  dockerfile(
    options: DockerfileEnvironmentInput = {},
  ): SandboxEnvironment<MicrosandboxSandboxRuntimeOptions, NetworkPolicySandboxSession> {
    return provider.environment(options);
  },
  image(
    reference: string,
    options: DockerfileEnvironmentInput = {},
  ): SandboxEnvironment<MicrosandboxSandboxRuntimeOptions, NetworkPolicySandboxSession> {
    return provider.environment({ ...options, image: reference });
  },
};
