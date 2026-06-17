import { createHash } from "node:crypto";

import type {
  DockerSandboxCreateOptions,
  DockerSandboxNetworkPolicy,
  DockerSandboxPullPolicy,
} from "#public/sandbox/docker-sandbox.js";

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
  readonly pullPolicy: DockerSandboxPullPolicy;
}

/**
 * Applies defaults to `docker(opts)`.
 */
export function resolveDockerSandboxOptions(
  options: DockerSandboxCreateOptions = {},
): ResolvedDockerSandboxOptions {
  return {
    env: options.env ?? {},
    image: options.image ?? DEFAULT_DOCKER_SANDBOX_IMAGE,
    networkPolicy: options.networkPolicy ?? "allow-all",
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
