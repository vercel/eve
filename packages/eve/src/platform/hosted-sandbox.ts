import { platformContext } from "#platform/context.js";
import { hostService, type HostedSandbox } from "#platform/services.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

function vercelHostedSandbox(): HostedSandbox {
  const onVercel = isVercelEnvironment();
  return {
    name: "vercel",
    selectByDefault: onVercel,
    credentialTransforms: onVercel,
    environment: (options) => VercelSandbox.environment(options),
  };
}

export function hostedSandbox(): HostedSandbox | undefined {
  return hostService(platformContext(), "hostedSandbox", vercelHostedSandbox);
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
