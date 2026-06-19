import { createHash } from "node:crypto";

import type {
  DockerSandboxCreateOptions,
  DockerSandboxNetworkPolicy,
  DockerSandboxPullPolicy,
} from "#public/sandbox/docker-sandbox.js";
import { normalizeSandboxPortMappings } from "#execution/sandbox/port-mappings.js";
import type { SandboxPortMapping } from "#shared/sandbox-session.js";

/**
 * Default base image for the Docker backend: eve's published sandbox
 * runtime image.
 */
export const DEFAULT_DOCKER_SANDBOX_IMAGE = "ghcr.io/vercel/eve:latest";

/**
 * Fully-defaulted Docker backend options consumed by the backend
 * implementation.
 */
export interface ResolvedDockerSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly networkPolicy: DockerSandboxNetworkPolicy;
  readonly ports: ReadonlyArray<SandboxPortMapping>;
  readonly pullPolicy: DockerSandboxPullPolicy;
}

/**
 * Applies defaults to `docker(opts)`.
 */
export function resolveDockerSandboxOptions(
  options: DockerSandboxCreateOptions = {},
): ResolvedDockerSandboxOptions {
  const networkPolicy = options.networkPolicy ?? "allow-all";
  const ports = normalizeSandboxPortMappings(options.ports);
  if (networkPolicy === "deny-all" && ports.length > 0) {
    throw new Error('Docker sandbox ports require networkPolicy: "allow-all".');
  }
  return {
    env: options.env ?? {},
    image: options.image ?? DEFAULT_DOCKER_SANDBOX_IMAGE,
    networkPolicy,
    ports,
    pullPolicy: options.pullPolicy ?? "if-not-present",
  };
}

export function createDockerSandboxOptionsHash(options: ResolvedDockerSandboxOptions): string {
  return createHash("sha256")
    .update(JSON.stringify(dockerOptionsForHash(options)))
    .digest("hex")
    .slice(0, 20);
}

function dockerOptionsForHash(options: ResolvedDockerSandboxOptions): Record<string, unknown> {
  return {
    env: sortStringRecord(options.env),
    image: options.image,
    networkPolicy: options.networkPolicy,
    ports: options.ports,
    pullPolicy: options.pullPolicy,
  };
}

function sortStringRecord(
  record: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
