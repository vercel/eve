import { createHash } from "node:crypto";

import { DEFAULT_EVE_SANDBOX_IMAGE } from "#execution/sandbox/bindings/eve-image.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxPullPolicy,
} from "#public/sandbox/docker-sandbox.js";

/**
 * Default base image for the Docker provider: eve's published sandbox
 * runtime image.
 */
export const DEFAULT_DOCKER_SANDBOX_IMAGE = DEFAULT_EVE_SANDBOX_IMAGE;

/**
 * Fully-defaulted Docker provider options consumed by the provider
 * implementation.
 */
export interface ResolvedDockerSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly pullPolicy: DockerSandboxPullPolicy;
}

/**
 * Applies defaults to `docker(opts)`.
 */
export function resolveDockerSandboxOptions(
  options: DockerSandboxEnvironmentOptions = {},
): ResolvedDockerSandboxOptions {
  return {
    env: options.env ?? {},
    image: options.image ?? DEFAULT_DOCKER_SANDBOX_IMAGE,
    pullPolicy: options.pullPolicy ?? "if-not-present",
  };
}

export function createDockerSandboxOptionsHash(options: ResolvedDockerSandboxOptions): string {
  return createHash("sha256")
    .update(JSON.stringify(dockerOptionsForHash(options)))
    .digest("hex")
    .slice(0, 20);
}

interface DockerTemplateOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly pullPolicy: DockerSandboxPullPolicy;
}

function dockerOptionsForHash(options: ResolvedDockerSandboxOptions): DockerTemplateOptions {
  return {
    env: sortStringRecord(options.env),
    image: options.image,
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
