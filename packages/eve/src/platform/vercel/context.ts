import { join } from "node:path";

import { hostCapabilities } from "#platform/capabilities.js";
import type { PlatformContext } from "#platform/context.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";
import { vercelWorkspaceTransport } from "#platform/vercel/workspace-transport.js";
import { toErrorMessage } from "#shared/errors.js";

const ON_VERCEL = hostCapabilities("1", {
  agentRuns: true,
  documentStore: true,
  hostedSandbox: true,
  modelCredentials: true,
  sandboxCredentialTransforms: true,
  scheduleProvider: true,
  stopsSandboxesOnExit: true,
});

const OFF_VERCEL = hostCapabilities("1", {
  agentRuns: true,
  modelCredentials: true,
  scheduleProvider: true,
});

export function createVercelPlatformContext(): PlatformContext {
  return {
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
    get capabilities() {
      return isVercelEnvironment() ? ON_VERCEL : OFF_VERCEL;
    },
    telemetry: {
      traceSessionAttribute: () =>
        process.env.VERCEL_ENV === undefined ? undefined : "vercel.session_id",
    },
    workspace: { transport: vercelWorkspaceTransport },
  };
}
