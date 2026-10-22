import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";
import { defineDockerSandboxProvider } from "#sandbox/providers/docker.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { LegacySandboxProviderImplementation } from "#shared/sandbox-provider.js";

/** What `DockerSandbox.environment(options)` gives core, over `cli`. */
export function createDockerSandboxRuntime(
  options?: DockerSandboxEnvironmentOptions,
  cli?: DockerCli,
): LegacySandboxProviderImplementation<
  DockerSandboxRuntimeOptions,
  { readonly imageReference: string },
  { readonly containerName: string; readonly version: 2 },
  DockerSandboxSession
> {
  return getSandboxEnvironmentRuntime(defineDockerSandboxProvider(cli).environment(options ?? {}))
    .implementation as LegacySandboxProviderImplementation<
    DockerSandboxRuntimeOptions,
    { readonly imageReference: string },
    { readonly containerName: string; readonly version: 2 },
    DockerSandboxSession
  >;
}
