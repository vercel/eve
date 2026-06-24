import { resolveDevelopmentOidcToken } from "#services/dev-client/request-headers.js";
import { formatDevelopmentOidcTokenFailure } from "#services/dev-client/vercel-auth-error.js";
import { runLoginFlow, type LoginFlowResult } from "#setup/flows/login.js";
import type { Prompter } from "#setup/prompter.js";
import {
  resolveVercelDeployment,
  type VercelDeploymentResolutionFailure,
  type VerifiedVercelTarget,
} from "#setup/vercel-deployment.js";
import { WizardCancelledError } from "#setup/step.js";
import {
  applyVercelTrustedSourceAccess,
  prepareVercelTrustedSourceAccess,
  type VercelTrustedSourceGrant,
} from "./vercel-trusted-sources.js";
import {
  appendRemoteAuthMutationSummary,
  type RemoteAuthCompletedMutation,
  type RemoteAuthPreparation,
} from "./remote-auth-result.js";
import { toErrorMessage } from "#shared/errors.js";

/** Injectable entry point for the remote authentication flow. */
export type RemoteAuthFlow = typeof runRemoteAuthFlow;
export interface RemoteAuthFlowDeps {
  readonly runLoginFlow: typeof runLoginFlow;
  readonly resolveVercelDeployment: typeof resolveVercelDeployment;
  readonly resolveOidcToken: typeof resolveDevelopmentOidcToken;
  readonly prepareVercelTrustedSourceAccess: typeof prepareVercelTrustedSourceAccess;
  readonly applyVercelTrustedSourceAccess: typeof applyVercelTrustedSourceAccess;
}

const defaultDeps: RemoteAuthFlowDeps = {
  runLoginFlow,
  resolveVercelDeployment,
  resolveOidcToken: resolveDevelopmentOidcToken,
  prepareVercelTrustedSourceAccess,
  applyVercelTrustedSourceAccess,
};

function failed(
  message: string,
  completedMutations: readonly RemoteAuthCompletedMutation[] = [],
): Extract<RemoteAuthPreparation, { kind: "failed" }> {
  return {
    kind: "failed",
    message: appendRemoteAuthMutationSummary(message, completedMutations),
    completedMutations: [...completedMutations],
  };
}

function cancelled(
  completedMutations: readonly RemoteAuthCompletedMutation[] = [],
): Extract<RemoteAuthPreparation, { kind: "cancelled" }> {
  return { kind: "cancelled", completedMutations: [...completedMutations] };
}

function loginFailure(result: LoginFlowResult): RemoteAuthPreparation | undefined {
  switch (result.kind) {
    case "already":
    case "logged-in":
      return undefined;
    case "cancelled":
      return cancelled();
    case "cli-missing":
      return failed(
        "The Vercel CLI is not installed. Install it with `npm i -g vercel@latest`, then retry /vc:auth.",
      );
    case "failed":
      return failed("Vercel login did not complete. Retry /vc:auth.");
    case "unavailable":
      return failed(
        "Vercel could not verify your account. Check your connection, then retry /vc:auth.",
      );
  }
}

function deploymentFailureMessage(failure: VercelDeploymentResolutionFailure): string {
  return failure.cause === "vercel" ? failure.failure.message : failure.message;
}

/**
 * Authenticates a remote by resolving its deployment URL to the owning Vercel
 * project, updating Trusted Sources when needed and keeping the resolved
 * credential in this TUI session.
 */
export async function runRemoteAuthFlow(input: {
  readonly workspaceRoot: string;
  readonly serverUrl: string;
  readonly configureTrustedSources?: boolean;
  readonly prompter: Prompter;
  readonly signal?: AbortSignal;
  readonly deps?: Partial<RemoteAuthFlowDeps>;
}): Promise<RemoteAuthPreparation> {
  const { workspaceRoot, serverUrl, prompter, signal } = input;
  const host = new URL(serverUrl).host;
  const deps: RemoteAuthFlowDeps = { ...defaultDeps, ...input.deps };
  const completedMutations: RemoteAuthCompletedMutation[] = [];
  let mutationStarted = false;

  try {
    // Authenticate first so the resolve runs under real credentials. When the
    // user is already logged in this is a no-op and shows no dialogue.
    const login = await deps.runLoginFlow({ appRoot: workspaceRoot, prompter, signal });
    const loginOutcome = loginFailure(login);
    if (loginOutcome !== undefined) return loginOutcome;
    if (login.kind === "logged-in") completedMutations.push({ kind: "vercel-login" });

    // A deployment hostname is globally unique, so Vercel resolves the project
    // and owning team straight from the URL under the caller's own access — no
    // team/project picker. If access is denied (for example an expired team SSO
    // session), re-authenticate through the same dialogue and resolve once more.
    let resolution = await deps.resolveVercelDeployment({ workspaceRoot, host, signal });
    if (resolution.kind === "forbidden") {
      const reauth = await deps.runLoginFlow({ appRoot: workspaceRoot, prompter, signal });
      const reauthOutcome = loginFailure(reauth);
      if (reauthOutcome !== undefined) return reauthOutcome;
      if (reauth.kind === "logged-in") completedMutations.push({ kind: "vercel-login" });
      signal?.throwIfAborted();
      resolution = await deps.resolveVercelDeployment({ workspaceRoot, host, signal });
    }

    let target: VerifiedVercelTarget;
    switch (resolution.kind) {
      case "resolved":
        target = resolution.target;
        break;
      case "cancelled":
        return cancelled(completedMutations);
      case "forbidden":
        return failed(
          `Could not access ${host}. Re-authenticate (for example to complete a team's SSO), then retry /vc:auth.`,
          completedMutations,
        );
      case "not-found":
        return failed(
          `Vercel did not resolve ${host} as a deployment you can access. If it belongs to a team that enforces SSO, re-authenticate and retry /vc:auth.`,
          completedMutations,
        );
      case "project-mismatch":
        return failed(
          `Could not verify ${host}: Vercel resolved project ${resolution.actualProjectId}, not ${resolution.expectedProjectId}.`,
          completedMutations,
        );
      case "failed":
        return failed(
          `Could not verify ${host} through Vercel: ${deploymentFailureMessage(resolution.failure)}`,
          completedMutations,
        );
    }

    let trustedSourcesGrant: VercelTrustedSourceGrant | undefined;
    if (input.configureTrustedSources === true) {
      const trustedSources = await deps.prepareVercelTrustedSourceAccess({
        workspaceRoot,
        target,
        prompter,
        signal,
      });
      signal?.throwIfAborted();
      if (trustedSources.kind === "cancelled") return cancelled(completedMutations);
      if (trustedSources.kind === "failed") {
        return failed(trustedSources.message, completedMutations);
      }
      if (trustedSources.kind === "approved") trustedSourcesGrant = trustedSources.grant;
    }

    signal?.throwIfAborted();
    if (trustedSourcesGrant !== undefined) {
      mutationStarted = true;
      const trustedSources = await deps.applyVercelTrustedSourceAccess({
        workspaceRoot,
        grant: trustedSourcesGrant,
        signal,
      });
      if (trustedSources.kind === "failed") {
        return failed(trustedSources.message, completedMutations);
      }
      if (trustedSources.kind === "updated") {
        completedMutations.push({
          kind: "trusted-sources-updated",
          targetProjectName: trustedSources.targetProjectName,
        });
      }
    }

    const tokenResolution = await deps.resolveOidcToken({
      ownerId: target.deployment.ownerId,
      projectId: target.deployment.projectId,
      forceRefresh: true,
    });
    signal?.throwIfAborted();
    if (tokenResolution.kind !== "resolved") {
      return failed(formatDevelopmentOidcTokenFailure(tokenResolution), completedMutations);
    }
    let token = tokenResolution.token.trim();
    const resolveToken = async (): Promise<string> => {
      const refreshed = await deps.resolveOidcToken(target.deployment);
      if (refreshed.kind === "resolved") token = refreshed.token.trim();
      return token;
    };
    return { kind: "prepared", target, resolveToken, completedMutations: [...completedMutations] };
  } catch (error) {
    if (!mutationStarted && (error instanceof WizardCancelledError || signal?.aborted === true)) {
      return cancelled(completedMutations);
    }
    return failed(`Could not authenticate ${host}: ${toErrorMessage(error)}`, completedMutations);
  }
}
