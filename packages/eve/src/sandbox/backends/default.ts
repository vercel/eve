import { SANDBOX_BACKEND_PROBES, type DefaultSandboxProbes } from "./probes.js";
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

export { SANDBOX_BACKEND_PROBES, type DefaultSandboxProbes } from "./probes.js";

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
 * Constructs an availability-aware sandbox backend. On first use it
 * picks the best backend the host supports, in priority order:
 *
 * 1. **Vercel Sandbox** when deploying on Vercel (`process.env.VERCEL`
 *    is set) — local container/VM runtimes cannot run there.
 * 2. **Docker** when a Linux-container Docker daemon is reachable.
 * 3. **microsandbox** when the host supports it (macOS on Apple
 *    Silicon, or glibc Linux with KVM); `eve dev` auto-installs the
 *    package into the project.
 * 4. **just-bash** as the dependency-free fallback; `eve dev`
 *    auto-installs the package into the project.
 *
 * The selection is cached for the process lifetime. To pin a backend
 * unconditionally, configure its factory directly (`docker()`,
 * `microsandbox()`, `justbash()`,
 * `vercel()`).
 */
export function defaultSandbox(opts?: DefaultSandboxOptions): SandboxBackend {
  return lazyBackend(() => selectDefaultSandbox(opts, SANDBOX_BACKEND_PROBES));
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
