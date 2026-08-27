import type { ClientOptions } from "#client/index.js";
import {
  hasDevelopmentAuthorizationHeader,
  resolveRemoteDevelopmentClientOptions,
} from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  type DevelopmentOidcTokenFailure,
  resolveDevelopmentOidcToken,
} from "#services/dev-client/request-headers.js";

import { resolveVercelDeployment, type VercelDeploymentResolution } from "./vercel-deployment.js";

/** Dependencies for verifying one remote client (injectable for tests). */
export interface VerifiedRemoteDevelopmentClientDeps {
  readonly resolveVercelDeployment: typeof resolveVercelDeployment;
  readonly resolveDevelopmentOidcToken: typeof resolveDevelopmentOidcToken;
}

/** A verified remote client's options plus a reader for its latest OIDC failure. */
export interface VerifiedRemoteDevelopmentClient {
  readonly deploymentResolution?: VercelDeploymentResolution;
  readonly options: ClientOptions;
  /** OIDC failure from the most recent request, or `undefined` while healthy. */
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
  readonly headers?: Readonly<Record<string, string>>;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly vercelScope?: string;
  readonly workspaceRoot: string;
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
}): Promise<VerifiedRemoteDevelopmentClient> {
  const deps = { ...defaultDeps, ...input.deps };
  const credentials = createDevelopmentCredentialGate(input.serverUrl);
  let deploymentResolution: VercelDeploymentResolution | undefined;

  if (!hasDevelopmentAuthorizationHeader(input.headers)) {
    deploymentResolution = await deps.resolveVercelDeployment({
      workspaceRoot: input.workspaceRoot,
      host: new URL(input.serverUrl).host,
      scope: input.vercelScope,
      signal: input.signal,
    });

    if (deploymentResolution.kind === "resolved") {
      const { ownerId, projectId } = deploymentResolution.target.deployment;
      credentials.authorize({
        target: deploymentResolution.target,
        resolveToken: () => deps.resolveDevelopmentOidcToken({ ownerId, projectId }),
      });
    }
  }

  return {
    deploymentResolution,
    options: resolveRemoteDevelopmentClientOptions({
      credentials,
      headers: input.headers,
      serverUrl: input.serverUrl,
    }),
    lastOidcTokenFailure: credentials.lastTokenFailure,
  };
}
