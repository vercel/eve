import { join } from "node:path";

import type { Build } from "#platform/entities.js";
import { vercelCompute } from "#platform/vercel/compute.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";
import { toErrorMessage } from "#shared/errors.js";

export const vercelBuild = {
  compute: vercelCompute(),
  schedules: {
    get kind() {
      return vercelScheduleProvider().kind;
    },
  },
  platformOutput: () => isVercelEnvironment(),
  outputDirectory: (appRoot) =>
    isVercelEnvironment() ? join(appRoot, ".vercel", "output") : undefined,
  sandboxPrewarmFailure: (providerName, error) =>
    isVercelEnvironment()
      ? new Error(
          `The ${providerName} sandbox provider is not available when deploying on Vercel. ` +
            "Vercel build containers cannot run local Docker containers. " +
            "Use DefaultSandbox.environment() so eve selects Vercel Sandbox on Vercel, or configure " +
            "VercelSandbox.environment() explicitly. " +
            `Original ${providerName} error: ${toErrorMessage(error)}`,
          { cause: error },
        )
      : undefined,
} satisfies Build;
