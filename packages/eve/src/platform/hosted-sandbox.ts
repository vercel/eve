import { installedPlatform } from "#platform/context.js";
import type { Compute, Entities } from "#platform/entities.js";
import { vercelCompute } from "#platform/vercel/compute.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

export function hostedSandboxOf(platform: Entities | undefined): Compute | undefined {
  return platform === undefined ? vercelCompute() : platform.compute;
}

export function hostedSandbox(): Compute | undefined {
  return hostedSandboxOf(installedPlatform());
}

export function hostedSandboxEnvironment(options?: VercelSandboxCreateOptions) {
  const sandbox = hostedSandbox();
  if (sandbox === undefined) {
    throw new Error(
      "The installed eve host has no hosted sandbox. Use DockerSandbox.environment() or JustBashSandbox.environment(), or add `compute` to the platform.",
    );
  }
  return sandbox.environment(options as never);
}
