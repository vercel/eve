import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

/**
 * Options accepted by `microsandbox(opts)`.
 *
 * The microsandbox backend runs sandboxes in lightweight local VMs via
 * [microsandbox](https://www.npmjs.com/package/microsandbox). Options
 * are eve-owned rather than a raw passthrough so the public surface can
 * stay stable while the underlying runtime evolves. Supported hosts:
 * macOS on Apple Silicon, or Linux (glibc) with KVM enabled.
 */
export interface MicrosandboxSandboxCreateOptions {
  /**
   * OCI image used as the base runtime. eve prepares this image with
   * Bash, the framework workspace, and the sandbox user before authored
   * bootstrap code runs. Install authored runtime tools such as Node,
   * Python, or ripgrep in sandbox bootstrap or provide them through a
   * custom image.
   *
   * @default "ghcr.io/vercel/eve:latest"
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
  /** Initial network policy applied to sandboxes after framework setup. */
  readonly networkPolicy?: SandboxNetworkPolicy;
}

/**
 * Options accepted by the microsandbox backend's `bootstrap({ use })` hook.
 */
export interface MicrosandboxBootstrapUseOptions {
  readonly networkPolicy?: SandboxNetworkPolicy;
}

/**
 * Options accepted by the microsandbox backend's `onSession({ use })` hook.
 */
export interface MicrosandboxSessionUseOptions {
  readonly networkPolicy?: SandboxNetworkPolicy;
}
