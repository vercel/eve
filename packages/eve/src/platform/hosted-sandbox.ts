import type { Compute } from "#platform/entities.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

export function hostedSandboxEnvironment(
  compute: Compute | undefined,
  options?: VercelSandboxCreateOptions,
) {
  if (compute === undefined) {
    throw new Error(
      "The installed eve host has no hosted sandbox. Use DockerSandbox.environment() or JustBashSandbox.environment(), or add `compute` to the platform.",
    );
  }
  return compute.environment(options as never);
}
