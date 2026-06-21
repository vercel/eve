import type { ClientOptions } from "#client/index.js";
import { resolveRemoteDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  type DevelopmentOidcTokenFailure,
  resolveDevelopmentOidcToken,
} from "#services/dev-client/request-headers.js";

import { resolveVercelDeployment } from "./vercel-deployment.js";

/** Injectable authority boundaries used while verifying one remote client target. */
export interface VerifiedRemoteDevelopmentClientDeps {
  readonly resolveVercelDeployment: typeof resolveVercelDeployment;
  readonly resolveDevelopmentOidcToken: typeof resolveDevelopmentOidcToken;
}

/** A verified remote client's options plus a reader for its latest OIDC failure. */
export interface VerifiedRemoteDevelopmentClient {
  readonly options: ClientOptions;
  /**
   * The OIDC token failure from the most recent request, or `undefined` while
   * healthy. Read it when a request fails to explain why credentials were not
   * attached.
   */
  readonly lastOidcTokenFailure: () => DevelopmentOidcTokenFailure | undefined;
}

const defaultDeps: VerifiedRemoteDevelopmentClientDeps = {
  resolveVercelDeployment,
  resolveDevelopmentOidcToken,
};

/**
 * Resolves a remote client that emits ambient Vercel credentials only after
 * exact origin proof, plus a reader for the latest OIDC token failure.
 */
export async function resolveVerifiedRemoteDevelopmentClient(input: {
  readonly serverUrl: string;
  readonly workspaceRoot: string;
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
}): Promise<VerifiedRemoteDevelopmentClient> {
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

  return {
    options: resolveRemoteDevelopmentClientOptions({ serverUrl: input.serverUrl, credentials }),
    lastOidcTokenFailure: credentials.lastTokenFailure,
  };
}
