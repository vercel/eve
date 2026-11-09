import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import { createSandboxEnvironmentHarness } from "#internal/testing/sandbox-provider-harness.js";
import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";
import { defineDockerSandboxProvider } from "#sandbox/providers/docker.js";

/** A harness over `DockerSandbox.environment(options)`, run against `cli`. */
export function createDockerSandboxHarness(
  input: {
    readonly cli?: DockerCli;
    readonly options?: DockerSandboxEnvironmentOptions;
    readonly preparedArtifact?: () => { readonly imageReference: string };
    readonly runtimeOptions?: DockerSandboxRuntimeOptions;
  } = {},
) {
  return createSandboxEnvironmentHarness<
    DockerSandboxRuntimeOptions,
    { readonly imageReference: string },
    { readonly containerName: string; readonly version: 2 },
    DockerSandboxSession
  >(defineDockerSandboxProvider(input.cli).environment(input.options ?? {}), input.runtimeOptions, {
    preparedArtifact: input.preparedArtifact,
  });
}
