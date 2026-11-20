import type { PlatformSandboxes } from "#platform/types.js";
import { VercelSandbox } from "#platform/vercel/sandbox/provider.js";

export const vercelSandboxes: PlatformSandboxes = {
  hostedEnvironment: (options) => VercelSandbox.environment(options),
};
