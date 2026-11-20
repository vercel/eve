import { platformHook } from "#platform/capabilities.js";
import { platformContext } from "#platform/context.js";
import { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

export function hostedSandboxEnvironment(options?: VercelSandboxCreateOptions) {
  const hostedSandbox = platformHook(platformContext(), "hostedSandbox", (createOptions) =>
    VercelSandbox.environment(createOptions),
  );
  if (hostedSandbox === undefined) {
    throw new Error(
      "The installed eve host doesn't provide a hosted sandbox. Use DockerSandbox.environment() or JustBashSandbox.environment(), or declare hostedSandbox in the host's capabilities and add a hostedSandbox hook.",
    );
  }
  return hostedSandbox(options as never);
}
