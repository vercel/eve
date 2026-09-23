import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import { createDockerSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

export type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";

type DockerfileEnvironmentInput = Omit<DockerSandboxEnvironmentOptions, "image">;

const provider = defineSandboxProvider<
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
  { readonly imageReference: string },
  { readonly containerName: string; readonly generation: string; readonly version: 2 },
  DockerSandboxSession
>({
  name: "docker",
  environment(options) {
    return createDockerSandboxProvider(options);
  },
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
