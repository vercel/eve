import { join } from "node:path";

import type { PlatformContext } from "#platform/context.js";
import { vercelSessionAttribute } from "#platform/vercel/core.js";
import { vercelDeployment, vercelDeploymentHost } from "#platform/vercel/deployment.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";
import { vercelNetwork } from "#platform/vercel/network.js";
import { toErrorMessage } from "#shared/errors.js";

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
    deployment: {
      environmentKind: vercelDeployment.environment,
      deploymentId: vercelDeployment.deploymentId,
      hostedDeploymentId: () => vercelDeployment.invocationData()["vercelDeploymentId"],
      build: vercelDeployment.build,
      productionHost: vercelDeployment.productionHost,
      deploymentHost: vercelDeploymentHost,
      publicHost: vercelDeployment.publicHost,
      isPlatformDevelopmentServer: vercelDeployment.localDevelopment,
      scope: vercelDeployment.scope,
      stopsSandboxesOnExit: isVercelEnvironment,
    },
    identity: {
      token: vercelNetwork.token,
      verifyOidcCaller: vercelIdentity.verifyOidcCaller,
      developmentCaller: vercelIdentity.developmentCaller,
      withDevelopmentRequestScope: vercelIdentity.developmentScope,
      callbackHeaders: vercelNetwork.self,
    },
    telemetry: { traceSessionAttribute: vercelSessionAttribute },
    workspace: { transport: vercelNetwork.peer },
  };
}
