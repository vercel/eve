import { join } from "node:path";

import type { PlatformContext } from "#platform/context.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";
import { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";
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
    memory: { defaultDocumentBackend: vercelDefaultDocumentBackend },
    models: {
      async gatewayCredential(...args) {
        const { resolveGatewayModelCredential } =
          await import("#platform/vercel/model-auth/gateway-credential.js");
        return await resolveGatewayModelCredential(...args);
      },
    },
    sandbox: {
      hostedAvailable: isVercelEnvironment,
      hostedEnvironment: (options) => VercelSandbox.environment(options),
      credentialTransforms: isVercelEnvironment,
      stopsOnExit: isVercelEnvironment,
    },
    schedules: { defaultProvider: () => vercelScheduleProvider() },
    telemetry: {
      traceSessionAttribute: () =>
        process.env.VERCEL_ENV === undefined ? undefined : "vercel.session_id",
      runtimeSpanProcessor: () => vercelRuntimeSpanProcessor(),
    },
    workspace: { transport: vercelWorkspaceTransport },
  };
}
