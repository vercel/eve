import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import type { DockerSandboxProviderOptions } from "#execution/sandbox/bindings/docker.js";
import {
  createDockerSandboxProvider,
  DOCKER_PROVIDER_NAME,
} from "#execution/sandbox/bindings/local.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
  DockerSandboxSession,
} from "#public/sandbox/docker-sandbox.js";
import { defineSandboxProvider, type SandboxProvider } from "#public/sandbox/provider.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";

export type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";

type DockerfileEnvironmentInput = Omit<DockerSandboxEnvironmentOptions, "image">;

/** Defines the Docker provider over `dockerCli`, the real `docker` CLI unless tests inject one. */
export function defineDockerSandboxProvider(
  dockerCli?: DockerCli,
): SandboxProvider<
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
  DockerSandboxSession
> {
  return defineSandboxProvider({
    name: DOCKER_PROVIDER_NAME,
    environment: (options: DockerSandboxProviderOptions) =>
      createDockerSandboxProvider(options, dockerCli),
  });
}

const provider = defineDockerSandboxProvider();

/**
 * Sandbox provider that runs each sandbox in a local Docker container. Use `image(reference)` for
 * an existing image, or `dockerfile()` for eve's default image or `agent/sandbox/Dockerfile`.
 */
export const DockerSandbox = {
  ...provider,
  dockerfile(
    options: DockerfileEnvironmentInput = {},
  ): SandboxEnvironment<DockerSandboxRuntimeOptions, DockerSandboxSession> {
    return provider.environment(options);
  },
  image(
    reference: string,
    options: DockerfileEnvironmentInput = {},
  ): SandboxEnvironment<DockerSandboxRuntimeOptions, DockerSandboxSession> {
    return provider.environment({ ...options, image: reference });
  },
};
