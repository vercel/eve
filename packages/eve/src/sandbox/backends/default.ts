import {
  isLinuxDockerDaemonAvailableSync,
  isMicrosandboxPlatformSupported,
} from "#execution/sandbox/bindings/local.js";
import { lazyBackend } from "#execution/sandbox/lazy-backend.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import { docker } from "#sandbox/backends/docker.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import { justbash } from "#sandbox/backends/just-bash.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { microsandbox } from "#sandbox/backends/microsandbox.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import { vercel } from "#sandbox/backends/vercel.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

/**
 * Input to {@link defaultSandbox}: a separate options bag per inner
 * backend. The framework picks one backend at runtime based on
 * availability and passes it the matching bag; the others are ignored.
 */
export interface DefaultSandboxOptions {
  readonly docker?: DockerSandboxCreateOptions;
  readonly justBash?: JustBashSandboxCreateOptions;
  readonly microsandbox?: MicrosandboxSandboxCreateOptions;
  readonly vercel?: VercelSandboxCreateOptions;
}

/**
 * Availability probes behind {@link defaultSandbox}'s selection chain.
 * Injectable so selection logic is testable without touching the host.
 */
export interface DefaultSandboxProbes {
  readonly isDeployedOnVercel: () => boolean;
  readonly isDockerAvailable: () => boolean;
  readonly isMicrosandboxSupported: () => boolean;
}

// Wrapped in arrows (not captured by reference) deliberately: this
// module participates in an import cycle through the runtime resolver,
// so the probe imports may still be uninitialized live bindings when
// this object literal evaluates. Accessing them at call time is safe.
const PRODUCTION_PROBES: DefaultSandboxProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
  isDockerAvailable: () => isLinuxDockerDaemonAvailableSync(),
  isMicrosandboxSupported: () => isMicrosandboxPlatformSupported(),
};

/**
 * Constructs an availability-aware sandbox backend. On first use it
 * picks the best backend the host supports, in priority order:
 *
 * 1. **Vercel Sandbox** when deploying on Vercel (`process.env.VERCEL`
 *    is set) — local container/VM runtimes cannot run there.
 * 2. **Docker** when a Linux-container Docker daemon is reachable.
 * 3. **microsandbox** when the host supports it (macOS on Apple
 *    Silicon, or glibc Linux where the current user can read and write
 *    `/dev/kvm`; `MSB_PATH` explicitly selects a custom runtime);
 *    `eve dev` auto-installs the package into the project.
 * 4. **just-bash** as the dependency-free fallback; `eve dev`
 *    auto-installs the package into the project.
 *
 * The selection is cached for the process lifetime. To pin a backend
 * unconditionally, configure its factory directly (`docker()`,
 * `microsandbox()`, `justbash()`,
 * `vercel()`).
 */
export function defaultSandbox(opts?: DefaultSandboxOptions): SandboxBackend {
  return lazyBackend(() => selectDefaultSandbox(opts, PRODUCTION_PROBES));
}

/**
 * The selection chain behind {@link defaultSandbox}. Internal —
 * exported for tests, which inject probes.
 */
export function selectDefaultSandbox(
  opts: DefaultSandboxOptions | undefined,
  probes: DefaultSandboxProbes,
): SandboxBackend {
  if (probes.isDeployedOnVercel()) {
    return vercel(opts?.vercel);
  }
  if (probes.isDockerAvailable()) {
    return docker(opts?.docker);
  }
  if (probes.isMicrosandboxSupported()) {
    return microsandbox(opts?.microsandbox);
  }
  return justbash(opts?.justBash);
}
