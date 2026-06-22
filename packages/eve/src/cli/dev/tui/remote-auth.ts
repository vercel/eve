import pc from "picocolors";

import { resolveDevelopmentOidcToken } from "#services/dev-client/request-headers.js";
import { formatDevelopmentOidcTokenFailure } from "#services/dev-client/vercel-auth-error.js";
import { runLoginFlow, type LoginFlowResult } from "#setup/flows/login.js";
import type { Prompter } from "#setup/prompter.js";
import {
  detectProjectIdentity,
  readProjectLink,
  type ProjectIdentity,
} from "#setup/project-resolution.js";
import {
  resolveVercelDeployment,
  type VercelDeploymentResolutionFailure,
  type VerifiedVercelTarget,
} from "#setup/vercel-deployment.js";
import { pickProject, pickTeam } from "#setup/vercel-project.js";
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
  readonly detectProjectIdentity: typeof detectProjectIdentity;
  readonly readProjectLink: typeof readProjectLink;
  readonly pickTeam: typeof pickTeam;
  readonly pickProject: typeof pickProject;
  readonly resolveVercelDeployment: typeof resolveVercelDeployment;
  readonly resolveOidcToken: typeof resolveDevelopmentOidcToken;
  readonly prepareVercelTrustedSourceAccess: typeof prepareVercelTrustedSourceAccess;
  readonly applyVercelTrustedSourceAccess: typeof applyVercelTrustedSourceAccess;
}

const defaultDeps: RemoteAuthFlowDeps = {
  runLoginFlow,
  detectProjectIdentity,
  readProjectLink,
  pickTeam,
  pickProject,
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

function currentProjectHint(identity: ProjectIdentity): string {
  const project = pc.bold(identity.projectName);
  return identity.teamName === undefined ? project : `${project} in ${identity.teamName}`;
}

function deploymentFailureMessage(failure: VercelDeploymentResolutionFailure): string {
  return failure.cause === "vercel" ? failure.failure.message : failure.message;
}

async function chooseProjectAction(
  prompter: Prompter,
  host: string,
  identity: ProjectIdentity,
): Promise<"current" | "change" | "cancel"> {
  return prompter.select({
    message: `Authenticate ${host}`,
    hintLayout: "stacked",
    options: [
      {
        value: "current",
        label: "Use current project",
        hint: currentProjectHint(identity),
      },
      {
        value: "change",
        label: "Select another Vercel project",
      },
      { value: "cancel", label: "Cancel" },
    ],
  });
}

async function selectProject(
  deps: RemoteAuthFlowDeps,
  workspaceRoot: string,
  prompter: Prompter,
  signal: AbortSignal | undefined,
): Promise<{ readonly projectId: string; readonly team: string }> {
  const team = await deps.pickTeam(prompter, workspaceRoot, undefined, { signal });
  const picked = await deps.pickProject(prompter, workspaceRoot, team, {
    allowCreateWhenEmpty: false,
    signal,
  });
  if (picked.kind !== "existing") {
    throw new Error("Remote authentication requires an existing Vercel project.");
  }
  return { projectId: picked.project.projectId, team: picked.team };
}

/**
 * Authenticates a remote through a verified Vercel project, updating Trusted
 * Sources when needed and keeping the selected credential in this TUI session.
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
    const login = await deps.runLoginFlow({
      appRoot: workspaceRoot,
      prompter,
      signal,
    });
    const loginOutcome = loginFailure(login);
    if (loginOutcome !== undefined) return loginOutcome;
    if (login.kind === "logged-in") completedMutations.push({ kind: "vercel-login" });

    const identity = await deps.detectProjectIdentity(workspaceRoot, { signal });
    signal?.throwIfAborted();

    let shouldSelectProject = identity === undefined;
    if (identity !== undefined) {
      const action = await chooseProjectAction(prompter, host, identity);
      if (action === "cancel") return cancelled(completedMutations);
      shouldSelectProject = action === "change";
    }

    let projectAuthority: { readonly orgId: string; readonly projectId: string } | undefined;
    if (shouldSelectProject) {
      try {
        const project = await selectProject(deps, workspaceRoot, prompter, signal);
        projectAuthority = { orgId: project.team, projectId: project.projectId };
      } catch (error) {
        if (error instanceof WizardCancelledError) return cancelled(completedMutations);
        signal?.throwIfAborted();
        return failed(
          `Could not select a Vercel project: ${toErrorMessage(error)}`,
          completedMutations,
        );
      }
    }
    if (!shouldSelectProject) {
      const link = await deps.readProjectLink(workspaceRoot);
      if (link !== undefined) {
        projectAuthority = { orgId: link.orgId, projectId: link.projectId };
      }
    }
    if (projectAuthority === undefined) {
      return failed("The directory is not linked to a valid Vercel project.", completedMutations);
    }
    const deploymentResolution = await deps.resolveVercelDeployment({
      workspaceRoot,
      host,
      signal,
      source: projectAuthority,
    });
    let target: VerifiedVercelTarget;
    switch (deploymentResolution.kind) {
      case "resolved":
        target = deploymentResolution.target;
        break;
      case "cancelled":
        return cancelled(completedMutations);
      case "not-found":
        return failed(
          `Vercel did not resolve ${host} as a deployment in the selected account.`,
          completedMutations,
        );
      case "unscoped":
        return failed(
          `Could not verify ${host}: the directory is not linked to a Vercel account.`,
          completedMutations,
        );
      case "project-mismatch":
        return failed(
          `Could not verify ${host}: Vercel resolved project ${deploymentResolution.actualProjectId}, not ${deploymentResolution.expectedProjectId}.`,
          completedMutations,
        );
      case "failed":
        return failed(
          `Could not verify ${host} through Vercel: ${deploymentFailureMessage(deploymentResolution.failure)}`,
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
