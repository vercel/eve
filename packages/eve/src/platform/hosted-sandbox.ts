import { platformContext } from "#platform/context.js";
import { hostService, type HostedSandbox } from "#platform/services.js";
import { vercelCompute } from "#platform/vercel/compute.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

export function hostedSandbox(): HostedSandbox | undefined {
  return hostService(platformContext(), "hostedSandbox", vercelCompute);
}

export function hostedSandboxEnvironment(options?: VercelSandboxCreateOptions) {
  const sandbox = hostedSandbox();
  if (sandbox === undefined) {
    throw new Error(
      "The installed eve host has no hosted sandbox. Use DockerSandbox.environment() or JustBashSandbox.environment(), or add hostedSandbox to the host's services.",
    );
  }
  return sandbox.environment(options as never);
}
