import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { JsonObject } from "#shared/json.js";
import {
  isSandboxNetworkPolicy,
  type SandboxNetworkPolicy,
} from "#shared/sandbox-network-policy.js";

export const MICROSANDBOX_DEFAULT_IMAGE = "ghcr.io/vercel/eve:latest";
export const MICROSANDBOX_DEFAULT_CPUS = 1;
export const MICROSANDBOX_DEFAULT_MEMORY_MIB = 1024;
export const MICROSANDBOX_DEFAULT_PULL_POLICY = "if-missing";
/** Matches hosted Vercel Sandbox so templates behave consistently across providers. */
export const MICROSANDBOX_USER = "vercel-sandbox";

export interface ResolvedMicrosandboxOptions {
  readonly cpus: number;
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly memoryMiB: number;
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly pullPolicy: "always" | "if-missing" | "never";
  readonly setup: {
    readonly autoInstall: boolean;
    readonly skipVerify: boolean;
  };
}

export function resolveMicrosandboxOptions(
  options: MicrosandboxSandboxCreateOptions | undefined,
): ResolvedMicrosandboxOptions {
  return {
    cpus: options?.cpus ?? MICROSANDBOX_DEFAULT_CPUS,
    env: options?.env ?? {},
    image: options?.image ?? MICROSANDBOX_DEFAULT_IMAGE,
    memoryMiB: options?.memoryMiB ?? MICROSANDBOX_DEFAULT_MEMORY_MIB,
    networkPolicy: options?.networkPolicy,
    pullPolicy: options?.pullPolicy ?? MICROSANDBOX_DEFAULT_PULL_POLICY,
    setup: {
      autoInstall: options?.setup?.autoInstall ?? true,
      skipVerify: options?.setup?.skipVerify ?? false,
    },
  };
}

/** Durable references are runtime data, so provider options are validated before reuse. */
export function decodeMicrosandboxCreateOptions(
  value: JsonObject,
): MicrosandboxSandboxCreateOptions {
  const setup = value.setup;
  if (
    !hasOnlyKeys(value, [
      "cpus",
      "env",
      "image",
      "memoryMiB",
      "networkPolicy",
      "pullPolicy",
      "setup",
    ]) ||
    (value.cpus !== undefined && typeof value.cpus !== "number") ||
    (value.env !== undefined && !isStringRecord(value.env)) ||
    (value.image !== undefined && typeof value.image !== "string") ||
    (value.memoryMiB !== undefined && typeof value.memoryMiB !== "number") ||
    (value.networkPolicy !== undefined && !isSandboxNetworkPolicy(value.networkPolicy)) ||
    (value.pullPolicy !== undefined &&
      value.pullPolicy !== "always" &&
      value.pullPolicy !== "if-missing" &&
      value.pullPolicy !== "never") ||
    (setup !== undefined && !isMicrosandboxSetup(setup))
  ) {
    throw new TypeError("Invalid microsandbox configuration in durable state.");
  }
  return {
    cpus: value.cpus,
    env: value.env,
    image: value.image,
    memoryMiB: value.memoryMiB,
    networkPolicy: value.networkPolicy,
    pullPolicy: value.pullPolicy,
    setup,
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
    pullPolicy: options.pullPolicy,
  };
}

function isMicrosandboxSetup(
  value: unknown,
): value is NonNullable<MicrosandboxSandboxCreateOptions["setup"]> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["autoInstall", "skipVerify"]) &&
    (value.autoInstall === undefined || typeof value.autoInstall === "boolean") &&
    (value.skipVerify === undefined || typeof value.skipVerify === "boolean")
  );
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
