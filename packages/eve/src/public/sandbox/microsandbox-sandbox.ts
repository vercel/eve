import type { SandboxSession } from "#shared/sandbox-session.js";
import type {
  SandboxNetworkOptions,
  SandboxNetworkPolicy,
} from "#shared/sandbox-network-policy.js";

/**
 * Options accepted by microsandbox environment constructors.
 *
 * The microsandbox provider runs sandboxes in lightweight local VMs via
 * [microsandbox](https://www.npmjs.com/package/microsandbox). Options
 * are eve-owned rather than a raw passthrough so the public surface can
 * stay stable while the underlying runtime evolves. Supported hosts:
 * macOS on Apple Silicon, or Linux (glibc) with KVM enabled.
 */
export interface MicrosandboxSandboxCreateOptions {
  /**
   * OCI image used as the base runtime. eve prepares this image with
   * Bash, the framework workspace, and the sandbox user before authored
   * environment preparation runs. Install authored runtime tools such as Node,
   * Python, or ripgrep during preparation or provide them through a
   * custom image.
   *
   * @default The `ghcr.io/vercel/eve` tag matching the installed eve version without build metadata, or `EVE_SANDBOX_IMAGE_TAG` when set.
   */
  readonly image?: string;
  /** Number of virtual CPUs assigned to each sandbox. @default 1 */
  readonly cpus?: number;
  /** Memory assigned to each sandbox in MiB. @default 1024 */
  readonly memoryMiB?: number;
  /** Environment variables applied to every sandbox command. */
  readonly env?: Readonly<Record<string, string>>;
  /** OCI image pull policy. @default "if-missing" */
  readonly pullPolicy?: "always" | "if-missing" | "never";
  /** Idempotent setup captured in the prepared VM snapshot. */
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
  /**
   * Installation behavior for the microsandbox npm package and its VM
   * runtime. By default eve installs both automatically when missing —
   * the npm package with the project's package manager (during
   * `eve dev` only), the runtime via microsandbox's own installer.
   */
  readonly setup?: {
    readonly autoInstall?: boolean;
    readonly skipVerify?: boolean;
  };
}

/** Options applied when eve creates one live microsandbox VM. */
export interface MicrosandboxSandboxRuntimeOptions extends SandboxNetworkOptions {
  /** Initial network policy for this VM. @default "allow-all" */
  readonly networkPolicy?: SandboxNetworkPolicy;
}
