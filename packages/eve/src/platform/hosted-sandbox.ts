import { platformContext, type PlatformTarget } from "#platform/context.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import { VercelSandbox } from "#platform/vercel/sandbox/provider.js";

const IMPLEMENTATIONS: Record<PlatformTarget, (typeof VercelSandbox)["environment"]> = {
  vercel: (options) => VercelSandbox.environment(options),
};

export function hostedSandboxEnvironment(options?: VercelSandboxCreateOptions) {
  return IMPLEMENTATIONS[platformContext().target](options);
}
