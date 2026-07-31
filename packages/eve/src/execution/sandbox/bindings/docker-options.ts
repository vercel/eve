import { createHash } from "node:crypto";

import type {
  DockerSandboxCreateOptions,
  DockerSandboxNetworkPolicy,
  DockerSandboxPullPolicy,
} from "#public/sandbox/docker-sandbox.js";
import type { JsonObject } from "#shared/json.js";

export const DEFAULT_DOCKER_SANDBOX_IMAGE = "ghcr.io/vercel/eve:latest";

export interface ResolvedDockerSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly networkPolicy: DockerSandboxNetworkPolicy;
  readonly pullPolicy: DockerSandboxPullPolicy;
}

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

/** Durable references are runtime data, so provider options are validated before reuse. */
export function decodeDockerSandboxCreateOptions(value: JsonObject): DockerSandboxCreateOptions {
  if (
    !hasOnlyKeys(value, ["env", "image", "networkPolicy", "pullPolicy"]) ||
    (value.env !== undefined && !isStringRecord(value.env)) ||
    (value.image !== undefined && typeof value.image !== "string") ||
    (value.networkPolicy !== undefined &&
      value.networkPolicy !== "allow-all" &&
      value.networkPolicy !== "deny-all") ||
    (value.pullPolicy !== undefined &&
      value.pullPolicy !== "always" &&
      value.pullPolicy !== "if-not-present" &&
      value.pullPolicy !== "never")
  ) {
    throw new TypeError("Invalid Docker sandbox configuration in durable state.");
  }
  return {
    env: value.env,
    image: value.image,
    networkPolicy: value.networkPolicy,
    pullPolicy: value.pullPolicy,
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

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
