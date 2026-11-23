import type { Compute } from "#platform/entities.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { VercelSandbox } from "#platform/vercel/sandbox/provider.js";

export function vercelCompute(): Compute {
  return {
    name: "vercel",
    get selectByDefault() {
      return isVercelEnvironment();
    },
    get credentialTransforms() {
      return isVercelEnvironment();
    },
    get platformStopsSandboxes() {
      return isVercelEnvironment();
    },
    environment: (options) => VercelSandbox.environment(options),
  };
}
