import {
  isLinuxDockerDaemonAvailableSync,
  isMicrosandboxPlatformSupported,
} from "#execution/sandbox/bindings/local.js";
import type { DockerSandboxEnvironmentOptions } from "#public/sandbox/docker-sandbox.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import { DockerSandbox } from "#sandbox/providers/docker.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { MicrosandboxSandbox } from "#sandbox/providers/microsandbox.js";
import { createDefaultVercelEnvironment } from "#sandbox/providers/vercel.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface DefaultSandboxEnvironmentOptions {
  readonly docker?: DockerSandboxEnvironmentOptions;
  readonly justBash?: JustBashSandboxCreateOptions;
  readonly microsandbox?: MicrosandboxSandboxCreateOptions;
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
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
  return {
    name: "default",
    environment(options: DefaultSandboxEnvironmentOptions = {}): SandboxEnvironment<undefined> {
      if (probes.isDeployedOnVercel()) {
        return withoutOpenOptions(
          createDefaultVercelEnvironment(withPreparation(options.vercel, options.prepare)),
        );
      }
      if (probes.isDockerAvailable()) {
        return withoutOpenOptions(
          DockerSandbox.environment(withPreparation(options.docker, options.prepare)),
        );
      }
      if (probes.isMicrosandboxSupported()) {
        return withoutOpenOptions(
          MicrosandboxSandbox.environment(withPreparation(options.microsandbox, options.prepare)),
        );
      }
      return JustBashSandbox.environment(withPreparation(options.justBash, options.prepare));
    },
  };
}

function withPreparation<Options extends object>(
  options: Options | undefined,
  prepare: ((sandbox: SandboxSession) => Promise<void> | void) | undefined,
) {
  return Object.assign({}, options, prepare === undefined ? {} : { prepare });
}

function withoutOpenOptions<Options extends object | undefined>(
  environment: SandboxEnvironment<Options>,
): SandboxEnvironment<undefined> {
  return environment as SandboxEnvironment<undefined>;
}
