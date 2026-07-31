import {
  isDockerDaemonAvailableSync,
  isMicrosandboxPlatformSupported,
} from "#execution/sandbox/bindings/local.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

/**
 * Per-provider options used when `DefaultSandbox` selects an available
 * implementation.
 */
export interface DefaultSandboxOptions {
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

const PRODUCTION_PROBES: DefaultSandboxProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
  isDockerAvailable: () => isDockerDaemonAvailableSync(),
  isMicrosandboxSupported: () => isMicrosandboxPlatformSupported(),
};

export type DefaultSandboxProviderName = "docker" | "just-bash" | "microsandbox" | "vercel";

export function selectAvailableDefaultSandboxProvider(): DefaultSandboxProviderName {
  return selectDefaultSandboxProvider(PRODUCTION_PROBES);
}

export function selectDefaultSandboxProvider(
  probes: DefaultSandboxProbes,
): DefaultSandboxProviderName {
  if (probes.isDeployedOnVercel()) {
    return "vercel";
  }
  if (probes.isDockerAvailable()) {
    return "docker";
  }
  if (probes.isMicrosandboxSupported()) {
    return "microsandbox";
  }
  return "just-bash";
}
