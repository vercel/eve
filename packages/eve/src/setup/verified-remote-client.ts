import type { ClientOptions } from "#client/index.js";
import { resolveRemoteDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import { resolveDevelopmentOidcToken } from "#services/dev-client/request-headers.js";

import { resolveVercelDeployment } from "./vercel-deployment.js";

/** Injectable authority boundaries used while verifying one remote client target. */
export interface VerifiedRemoteDevelopmentClientDeps {
  readonly resolveVercelDeployment: typeof resolveVercelDeployment;
  readonly resolveDevelopmentOidcToken: typeof resolveDevelopmentOidcToken;
}

const defaultDeps: VerifiedRemoteDevelopmentClientDeps = {
  resolveVercelDeployment,
  resolveDevelopmentOidcToken,
};

/**
 * Resolves client options that emit ambient Vercel credentials only after
 * exact origin proof.
 */
export async function resolveVerifiedRemoteDevelopmentClientOptions(input: {
  readonly serverUrl: string;
  readonly workspaceRoot: string;
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
}): Promise<ClientOptions> {
  const deps = { ...defaultDeps, ...input.deps };
  const credentials = createDevelopmentCredentialGate(input.serverUrl);
  const resolution = await deps.resolveVercelDeployment({
    workspaceRoot: input.workspaceRoot,
    host: new URL(input.serverUrl).host,
  });

  if (resolution.kind === "resolved") {
    const { ownerId, projectId } = resolution.target.deployment;
    credentials.authorize({
      target: resolution.target,
      resolveToken: () => deps.resolveDevelopmentOidcToken({ ownerId, projectId }),
    });
  }

  return resolveRemoteDevelopmentClientOptions({
    serverUrl: input.serverUrl,
    credentials,
  });
}
