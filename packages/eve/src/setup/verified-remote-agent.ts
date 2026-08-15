import { Client, ClientError, type AgentInfoResult, type ClientOptions } from "#client/index.js";
import { runRemoteAuthFlow, type RemoteAuthFlow } from "#cli/dev/tui/remote-auth.js";
import type { Prompter } from "#setup/prompter.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClient,
} from "#setup/verified-remote-client.js";
import { WizardCancelledError } from "#setup/step.js";

/** Result of inspecting an authenticated remote eve agent. */
export interface VerifiedRemoteAgentInspection {
  readonly info: AgentInfoResult;
  /** Verified Vercel scope to retain when reconnecting to the same deployment. */
  readonly vercelScope?: string;
}

/** @internal Dependencies for testing verified remote inspection. */
export interface InspectVerifiedRemoteAgentDeps {
  readonly createClient: (options: ClientOptions) => Pick<Client, "info">;
  readonly resolveVerifiedRemoteDevelopmentClient: (
    input: Parameters<typeof resolveVerifiedRemoteDevelopmentClient>[0],
  ) => Promise<VerifiedRemoteDevelopmentClient>;
  readonly runRemoteAuthFlow: RemoteAuthFlow;
}

const defaultDeps: InspectVerifiedRemoteAgentDeps = {
  createClient: (options) => new Client(options),
  resolveVerifiedRemoteDevelopmentClient,
  runRemoteAuthFlow,
};

/**
 * Inspects a remote eve agent using the same exact-origin credential boundary
 * as remote development clients. When a verified Vercel target needs login or
 * Trusted Sources configuration, an optional prompter completes that flow
 * before inspection is retried.
 */
export async function inspectVerifiedRemoteAgent(input: {
  readonly serverUrl: string;
  readonly workspaceRoot: string;
  readonly prompter?: Prompter;
  readonly signal?: AbortSignal;
  /** @internal Test seam. */
  readonly deps?: Partial<InspectVerifiedRemoteAgentDeps>;
}): Promise<VerifiedRemoteAgentInspection> {
  const deps = { ...defaultDeps, ...input.deps };
  const verified = await deps.resolveVerifiedRemoteDevelopmentClient({
    serverUrl: input.serverUrl,
    signal: input.signal,
    workspaceRoot: input.workspaceRoot,
  });

  try {
    return inspection(await deps.createClient(verified.options).info(), verifiedScope(verified));
  } catch (error) {
    if (
      input.prompter === undefined ||
      !isAuthenticationFailure(error) ||
      !canAuthenticateInteractively(error, verified)
    ) {
      throw error;
    }
  }

  const authentication = await deps.runRemoteAuthFlow({
    configureTrustedSources: true,
    prompter: input.prompter,
    serverUrl: input.serverUrl,
    signal: input.signal,
    workspaceRoot: input.workspaceRoot,
  });
  if (authentication.kind === "cancelled") throw new WizardCancelledError();
  if (authentication.kind === "failed") throw new Error(authentication.message);

  const options: ClientOptions = {
    ...verified.options,
    auth: { vercelOidc: { token: authentication.resolveToken } },
    host: input.serverUrl,
    redirect: "manual",
  };
  return inspection(
    await deps.createClient(options).info(),
    authentication.target.deployment.ownerId,
  );
}

function inspection(
  info: AgentInfoResult,
  vercelScope: string | undefined,
): VerifiedRemoteAgentInspection {
  return vercelScope === undefined ? { info } : { info, vercelScope };
}

function verifiedScope(client: VerifiedRemoteDevelopmentClient): string | undefined {
  const resolution = client.deploymentResolution;
  return resolution?.kind === "resolved" ? resolution.target.deployment.ownerId : undefined;
}

function isAuthenticationFailure(error: unknown): error is ClientError {
  return (
    error instanceof ClientError &&
    ((error.status >= 300 && error.status < 400) || error.status === 401 || error.status === 403)
  );
}

function canAuthenticateInteractively(
  error: ClientError,
  client: VerifiedRemoteDevelopmentClient,
): boolean {
  if (
    error.status >= 300 &&
    error.status < 400 &&
    (error.headers.location ?? "").includes("vercel.com/sso-api")
  ) {
    return true;
  }
  return (
    client.deploymentResolution?.kind === "resolved" ||
    client.deploymentResolution?.kind === "forbidden"
  );
}
