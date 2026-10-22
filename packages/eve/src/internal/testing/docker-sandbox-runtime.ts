import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import {
  createDockerSandboxProvider,
  DOCKER_PROVIDER_NAME,
  type DockerSandboxProviderOptions,
} from "#execution/sandbox/bindings/docker.js";
import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";
import { defineSandboxProvider } from "#sandbox/provider.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { LegacySandboxProviderImplementation } from "#shared/sandbox-provider.js";

/**
 * What `DockerSandbox.environment(options)` gives core, over `cli`: the
 * Docker provider compiled through the public `defineSandboxProvider()`.
 */
export function createDockerSandboxRuntime(
  options?: DockerSandboxEnvironmentOptions,
  cli?: DockerCli,
): LegacySandboxProviderImplementation<
  DockerSandboxRuntimeOptions,
  { readonly imageReference: string },
  { readonly containerName: string; readonly version: 2 },
  DockerSandboxSession
> {
  const provider = defineSandboxProvider({
    name: DOCKER_PROVIDER_NAME,
    environment: (environmentOptions: DockerSandboxProviderOptions) =>
      createDockerSandboxProvider(environmentOptions, cli),
  });
  return getSandboxEnvironmentRuntime(provider.environment(options ?? {}))
    .implementation as LegacySandboxProviderImplementation<
    DockerSandboxRuntimeOptions,
    { readonly imageReference: string },
    { readonly containerName: string; readonly version: 2 },
    DockerSandboxSession
  >;
}
