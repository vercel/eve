import { confirm, text } from "#setup/ask.js";
import {
  classifySelfModificationConfig,
  connectorName,
  defaultSelfModificationSetupOperations,
  directoryError,
  gitRefError,
  renderSelfModificationConfig,
  repositoryPartError,
  type SelfModificationSetupOperations,
  type SelfModificationSetupValues,
} from "#self-modification/setup.js";
import { SELF_MODIFICATION_CONFIG_PATH } from "#self-modification/git-workspace.js";

import { describeIntegrationSetupEnvironment } from "../shared/environment.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

type SelfModificationSetupPlan =
  | { readonly kind: "authored" }
  | { readonly kind: "local" }
  | {
      readonly kind: "deployed";
      readonly connectorName: string;
      readonly values: SelfModificationSetupValues;
    };

function validationResult(error: string | undefined): string | null {
  return error ?? null;
}

export async function prepareSelfModificationSetup(
  context: SetupPrepareContext,
  operations: SelfModificationSetupOperations = defaultSelfModificationSetupOperations(
    context.appRoot,
  ),
): Promise<SelfModificationSetupPlan> {
  const existing = await operations.readConfig();
  if (classifySelfModificationConfig(existing) === "authored") {
    context.presenter.note(
      `The existing ${SELF_MODIFICATION_CONFIG_PATH} contains authored configuration and was not overwritten.`,
      "Manual update required",
      { tone: "warning" },
    );
    return { kind: "authored" };
  }

  const enableDeployed = await context.asker.ask(
    confirm({
      key: "self-modification-deployed",
      message: "Enable draft pull requests from deployed sessions?",
      recommended: false,
      required: true,
    }),
  );
  if (!enableDeployed) return { kind: "local" };

  const detected = await operations.detectGitRepository();
  const owner = await context.asker.ask(
    text({
      key: "self-modification-repository-owner",
      message: "GitHub repository owner",
      detected: detected.owner,
      required: true,
      validate: (value) => validationResult(repositoryPartError(value)),
    }),
  );
  const repo = await context.asker.ask(
    text({
      key: "self-modification-repository-name",
      message: "GitHub repository name",
      detected: detected.repo,
      required: true,
      validate: (value) => validationResult(repositoryPartError(value)),
    }),
  );
  const directory = await context.asker.ask(
    text({
      key: "self-modification-repository-directory",
      message: "Application directory relative to the repository root",
      detected: detected.directory ?? ".",
      required: true,
      validate: (value) => validationResult(directoryError(value)),
    }),
  );
  const branch = await context.asker.ask(
    text({
      key: "self-modification-target-branch",
      message: "Target branch",
      detected: detected.branch ?? "main",
      required: true,
      validate: (value) => validationResult(gitRefError(value)),
    }),
  );
  const name = connectorName(owner, repo);
  const values = {
    branch,
    connector: `github/${name}`,
    directory,
    repository: `github.com/${owner}/${repo}`,
  };
  context.presenter.note(
    renderSelfModificationConfig(values),
    `Generated ${SELF_MODIFICATION_CONFIG_PATH}`,
  );
  context.presenter.note(
    "Vercel Connect will issue short-lived GitHub App credentials restricted to this repository. Install the managed GitHub App and select only this repository. Review, merge, and deployment remain separate operator boundaries.",
    "Security summary",
  );
  const confirmed = await context.asker.ask(
    confirm({
      key: "self-modification-confirm",
      message: "Create or attach this GitHub connector and write this configuration?",
      recommended: false,
      required: true,
    }),
  );
  return confirmed ? { kind: "deployed", connectorName: name, values } : { kind: "local" };
}

export async function applySelfModificationSetup(
  plan: SelfModificationSetupPlan,
  context: SetupApplyContext,
  operations: SelfModificationSetupOperations = defaultSelfModificationSetupOperations(
    context.appRoot,
  ),
) {
  if (plan.kind === "authored") {
    return {
      facts: [{ label: "Self-modification", value: "manual configuration update required" }],
    };
  }
  if (plan.kind === "local") {
    return { facts: [{ label: "Self-modification", value: "local editing" }] };
  }

  const connector = await operations.findOrCreateConnector(plan.connectorName);
  await operations.attachConnector(connector);
  await operations.writeConfig(renderSelfModificationConfig({ ...plan.values, connector }));
  context.presenter.log.success(`Updated ${SELF_MODIFICATION_CONFIG_PATH}.`);
  context.presenter.nextSteps([
    "Install the managed GitHub App for the configured repository, then redeploy.",
  ]);
  return {
    deploymentRequired: true as const,
    facts: [
      { label: "Repository", value: plan.values.repository },
      { label: "Application directory", value: plan.values.directory },
      { label: "Target branch", value: plan.values.branch },
      { label: "Credential", value: connector },
    ],
  };
}

export const SELF_MODIFICATION_SETUP = defineSetupIntegration({
  kind: "self-modification",
  label: "Self-modification",
  hint: "Local source editing is enabled by default",
  describeEnvironment(environment) {
    if (environment.vercel.kind === "available") {
      return describeIntegrationSetupEnvironment(environment);
    }
    switch (environment.vercel.reason) {
      case "logged-out":
        return "No authenticated Vercel account found. Local editing remains available; deployed proposals require Vercel Connect.";
      case "cli-missing":
        return "Vercel CLI not found. Local editing remains available; deployed proposals require Vercel Connect.";
      case "unavailable":
        return "Could not verify the Vercel account. Local editing remains available; deployed proposals require Vercel Connect.";
    }
  },
  prepare: prepareSelfModificationSetup,
  apply: applySelfModificationSetup,
});
