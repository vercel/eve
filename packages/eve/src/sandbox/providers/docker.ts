import { createDockerSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import {
  defineSandboxProvider,
  type SandboxProviderEnvironmentOptions,
} from "#shared/sandbox-provider.js";

export type DockerSandboxEnvironmentOptions = DockerSandboxCreateOptions;

type DockerEnvironmentInput = SandboxProviderEnvironmentOptions<DockerSandboxEnvironmentOptions>;
type DockerfileEnvironmentInput = Omit<DockerEnvironmentInput, "image">;

const provider = defineSandboxProvider<DockerSandboxEnvironmentOptions, undefined>({
  name: "docker",
  environment(options) {
    return createDockerSandboxProvider(options);
  },
});

export const DockerSandbox = {
  ...provider,
  dockerfile(options: DockerfileEnvironmentInput = {}): SandboxEnvironment<undefined> {
    const environment = provider.environment(options);
    return Object.defineProperty(environment, "kind", { value: "dockerfile" });
  },
  image(
    reference: string,
    options: DockerfileEnvironmentInput = {},
  ): SandboxEnvironment<undefined> {
    const environment = provider.environment({ ...options, image: reference });
    return Object.defineProperty(environment, "kind", { value: "image" });
  },
};
