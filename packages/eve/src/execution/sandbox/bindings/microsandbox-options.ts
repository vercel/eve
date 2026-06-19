import type { MicrosandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import { normalizeSandboxPortMappings } from "#execution/sandbox/port-mappings.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxPortMapping } from "#shared/sandbox-session.js";

export const MICROSANDBOX_DEFAULT_IMAGE = "ghcr.io/vercel/eve:latest";
export const MICROSANDBOX_DEFAULT_CPUS = 1;
export const MICROSANDBOX_DEFAULT_MEMORY_MIB = 1024;
export const MICROSANDBOX_DEFAULT_PULL_POLICY = "if-missing";
/** User every sandbox command runs as, mirroring hosted Vercel Sandbox. */
export const MICROSANDBOX_USER = "vercel-sandbox";

/**
 * Fully-defaulted microsandbox backend options consumed by the backend
 * implementation.
 */
export interface ResolvedMicrosandboxOptions {
  readonly cpus: number;
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly memoryMiB: number;
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly ports: ReadonlyArray<SandboxPortMapping>;
  readonly pullPolicy: "always" | "if-missing" | "never";
  readonly setup: {
    readonly autoInstall: boolean;
    readonly skipVerify: boolean;
  };
}

/**
 * Applies defaults to `microsandbox(opts)`.
 */
export function resolveMicrosandboxOptions(
  options: MicrosandboxCreateOptions | undefined,
): ResolvedMicrosandboxOptions {
  const networkPolicy = options?.networkPolicy;
  const ports = normalizeSandboxPortMappings(options?.ports);
  if (networkPolicy === "deny-all" && ports.length > 0) {
    throw new Error('Microsandbox ports require a network policy other than "deny-all".');
  }
  return {
    cpus: options?.cpus ?? MICROSANDBOX_DEFAULT_CPUS,
    env: options?.env ?? {},
    image: options?.image ?? MICROSANDBOX_DEFAULT_IMAGE,
    memoryMiB: options?.memoryMiB ?? MICROSANDBOX_DEFAULT_MEMORY_MIB,
    networkPolicy,
    ports,
    pullPolicy: options?.pullPolicy ?? MICROSANDBOX_DEFAULT_PULL_POLICY,
    setup: {
      autoInstall: options?.setup?.autoInstall ?? true,
      skipVerify: options?.setup?.skipVerify ?? false,
    },
  };
}

/**
 * The subset of options that participates in template/session
 * compatibility hashing. Setup behavior intentionally stays out: how
 * the runtime got installed must not invalidate captured templates.
 */
export function microsandboxOptionsForHash(
  options: ResolvedMicrosandboxOptions,
): Record<string, unknown> {
  return {
    cpus: options.cpus,
    env: options.env,
    image: options.image,
    memoryMiB: options.memoryMiB,
    ports: options.ports,
    pullPolicy: options.pullPolicy,
  };
}
