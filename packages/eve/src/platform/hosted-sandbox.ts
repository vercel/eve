import type { Compute, Entities } from "#platform/entities.js";
import { vercelCompute } from "#platform/vercel/compute.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

export function hostedSandboxOf(platform: Entities | undefined): Compute | undefined {
  return platform === undefined ? vercelCompute() : platform.compute;
}

export function hostedSandboxEnvironment(
  platform: Entities | undefined,
  options?: VercelSandboxCreateOptions,
) {
  const sandbox = hostedSandboxOf(platform);
  if (sandbox === undefined) {
    throw new Error(
      "The installed eve host has no hosted sandbox. Use DockerSandbox.environment() or JustBashSandbox.environment(), or add `compute` to the platform.",
    );
  }
  return sandbox.environment(options as never);
}
