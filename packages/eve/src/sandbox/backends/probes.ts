import { isLinuxDockerDaemonAvailableSync } from "#execution/sandbox/bindings/docker-cli.js";
import { isMicrosandboxPlatformSupported } from "#execution/sandbox/bindings/microsandbox-platform.js";

/** Availability probes shared by built-in backend selectors. */
export interface DefaultSandboxProbes {
  readonly isDeployedOnVercel: () => boolean;
  readonly isDockerAvailable: () => boolean;
  readonly isMicrosandboxSupported: () => boolean;
}

// Keep probes separate from backend factories so authored selectors do not bundle engines.
export const SANDBOX_BACKEND_PROBES: DefaultSandboxProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
  isDockerAvailable: () => isLinuxDockerDaemonAvailableSync(),
  isMicrosandboxSupported: () => isMicrosandboxPlatformSupported(),
};
