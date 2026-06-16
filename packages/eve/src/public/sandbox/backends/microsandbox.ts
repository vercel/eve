import { createMicrosandboxSandboxBackend } from "#execution/sandbox/bindings/local.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type {
  MicrosandboxBootstrapUseOptions,
  MicrosandboxCreateOptions,
  MicrosandboxSessionUseOptions,
} from "#public/sandbox/microsandbox-sandbox.js";

/**
 * Constructs the microsandbox sandbox backend: lightweight local VMs
 * via [microsandbox](https://www.npmjs.com/package/microsandbox) with
 * snapshot-backed templates and a firewall capable of domain-level
 * network policies and credential brokering.
 *
 * Supported hosts: macOS on Apple Silicon, or Linux (glibc) with KVM
 * enabled. The `microsandbox` package is not bundled with eve. When it
 * (or its VM runtime) is missing, `eve dev` installs both
 * automatically (disable with `setup: { autoInstall: false }`);
 * production processes fail with actionable errors instead.
 * Configuring this backend pins it unconditionally — when you want
 * fallback behavior, use `defaultBackend()` instead.
 */
export function microsandbox(
  opts?: MicrosandboxCreateOptions,
): SandboxBackend<MicrosandboxBootstrapUseOptions, MicrosandboxSessionUseOptions> {
  return createMicrosandboxSandboxBackend({ createOptions: opts });
}
