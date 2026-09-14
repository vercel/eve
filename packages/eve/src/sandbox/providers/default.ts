import {
  isLinuxDockerDaemonAvailableSync,
  isMicrosandboxPlatformSupported,
} from "#execution/sandbox/bindings/local.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import { DockerSandbox } from "#sandbox/providers/docker.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { MicrosandboxSandbox } from "#sandbox/providers/microsandbox.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";

export interface DefaultSandboxEnvironmentOptions {
  readonly docker?: DockerSandboxCreateOptions;
  readonly justBash?: JustBashSandboxCreateOptions;
  readonly microsandbox?: MicrosandboxSandboxCreateOptions;
  readonly vercel?: VercelSandboxCreateOptions;
}

export interface DefaultSandboxProbes {
  readonly isDeployedOnVercel: () => boolean;
  readonly isDockerAvailable: () => boolean;
  readonly isMicrosandboxSupported: () => boolean;
}

export const SANDBOX_PROVIDER_PROBES: DefaultSandboxProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
  isDockerAvailable: () => isLinuxDockerDaemonAvailableSync(),
  isMicrosandboxSupported: () => isMicrosandboxPlatformSupported(),
};

export const DefaultSandbox = defineDefaultSandboxProvider(SANDBOX_PROVIDER_PROBES);

export function defineDefaultSandboxProvider(probes: DefaultSandboxProbes) {
  return defineSandboxProvider<DefaultSandboxEnvironmentOptions, undefined>({
    name: "default",
    select(options, prepare) {
      if (probes.isDeployedOnVercel()) {
        return withoutCreateOptions(VercelSandbox.environment({ ...options.vercel, prepare }));
      }
      if (probes.isDockerAvailable()) {
        return DockerSandbox.environment({ ...options.docker, prepare });
      }
      if (probes.isMicrosandboxSupported()) {
        return MicrosandboxSandbox.environment({ ...options.microsandbox, prepare });
      }
      return JustBashSandbox.environment({ ...options.justBash, prepare });
    },
  });
}

function withoutCreateOptions<Options extends object | undefined>(
  environment: SandboxEnvironment<Options>,
): SandboxEnvironment<undefined> {
  return environment as SandboxEnvironment<undefined>;
}
