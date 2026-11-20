import { join } from "node:path";

import type { PlatformContext } from "#platform/context.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";
import { vercelWorkspaceTransport } from "#platform/vercel/workspace-transport.js";
import { toErrorMessage } from "#shared/errors.js";

export function createVercelPlatformContext(): PlatformContext {
  return {
    target: "vercel",
    build: {
      target: () => (isVercelEnvironment() ? "vercel" : "node"),
      outputDirectory: (appRoot) =>
        isVercelEnvironment() ? join(appRoot, ".vercel", "output") : undefined,
      localSandboxPrewarmFailure: (providerName, error) =>
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
    },
    deployment: vercelDeployment,
    identity: vercelIdentity,
    sandbox: {
      hostedAvailable: isVercelEnvironment,
      credentialTransforms: isVercelEnvironment,
      stopsOnExit: isVercelEnvironment,
    },
    telemetry: {
      traceSessionAttribute: () =>
        process.env.VERCEL_ENV === undefined ? undefined : "vercel.session_id",
    },
    workspace: { transport: vercelWorkspaceTransport },
  };
}
