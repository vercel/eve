import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import { createDockerSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";
import { defineSandboxProvider, type SandboxProvider } from "#public/sandbox/provider.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";

export type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";

type DockerfileEnvironmentInput = Omit<DockerSandboxEnvironmentOptions, "image">;

const provider: SandboxProvider<
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
  DockerSandboxSession
> = defineSandboxProvider({
  name: "docker",
  environment: (options: Omit<DockerSandboxEnvironmentOptions, "prepare">) =>
    createDockerSandboxProvider(options),
});

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
