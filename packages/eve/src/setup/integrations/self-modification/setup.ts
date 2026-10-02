import { relative } from "node:path";

import { confirm, select, text } from "#setup/ask.js";
import {
  classifySelfModificationConfig,
  connectorName,
  DEPLOYED_SELF_MODIFICATION_CONFIG_PATH,
  defaultSelfModificationSetupOperations,
  directoryError,
  gitRefError,
  renderSelfModificationConfig,
  repositoryNameError,
  repositoryOwnerError,
  SELF_MODIFICATION_CONFIG_PATH,
  type SelfModificationSetupOperations,
  type SelfModificationSetupValues,
} from "#self-modification/setup.js";
import {
  detectLegacySelfModificationScaffold,
  removeLegacySelfModificationScaffold,
  type LegacySelfModificationScaffold,
} from "#self-modification/migration.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { ensurePackageDependencies } from "#setup/scaffold/index.js";
import { DEFAULT_MICROSANDBOX_PACKAGE_VERSION } from "#setup/scaffold/version-tokens.js";

import { describeIntegrationSetupEnvironment } from "../shared/environment.js";
import { installScaffoldDependencies } from "../shared/scaffold.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export interface SelfModificationApplyDependencies {
  ensurePackageDependencies: typeof ensurePackageDependencies;
  installScaffoldDependencies: typeof installScaffoldDependencies;
}

const defaultApplyDependencies: SelfModificationApplyDependencies = {
  ensurePackageDependencies,
  installScaffoldDependencies,
};

const SELF_MODIFICATION_PRODUCTION_DEPENDENCIES = {
  microsandbox: DEFAULT_MICROSANDBOX_PACKAGE_VERSION,
};

type SelfModificationSetupPlan = (
  | { readonly kind: "authored" }
  | { readonly kind: "local" }
  | {
      readonly kind: "deployed";
      readonly connectorName: string;
      readonly project: VercelProjectReference;
      readonly values: SelfModificationSetupValues;
    }
) & { readonly legacyScaffold?: LegacySelfModificationScaffold };

const AUTHORIZATION_WARNING = `The generated configuration uses \`authorize: () => true\`, so any caller that can reach the deployed agent can ask it to open draft pull requests. Setting a custom \`authorize\` policy that checks the caller's principal and channel is recommended before deploying.`;

function validationResult(error: string | undefined): string | null {
  return error ?? null;
}

async function prepareLegacyScaffoldCleanup(
  context: SetupPrepareContext,
): Promise<LegacySelfModificationScaffold | undefined> {
  const scaffold = await detectLegacySelfModificationScaffold(context.appRoot);
  if (scaffold === undefined) return undefined;

  const approved = await context.asker.ask(
    confirm({
      key: "self-modification-cleanup",
      message: `A legacy self-modification scaffold was found at ${relative(context.appRoot, scaffold.root)}. This scaffold format is no longer supported. Do you want to remove it?`,
      recommended: true,
      required: true,
    }),
  );
  return approved ? scaffold : undefined;
}

function withLegacyScaffold(
  plan: SelfModificationSetupPlan,
  legacyScaffold: LegacySelfModificationScaffold | undefined,
): SelfModificationSetupPlan {
  return legacyScaffold === undefined ? plan : { ...plan, legacyScaffold };
}

export async function prepareSelfModificationSetup(
  context: SetupPrepareContext,
  operations: SelfModificationSetupOperations = defaultSelfModificationSetupOperations(
    context.appRoot,
    undefined,
    context.projectRoot,
  ),
): Promise<SelfModificationSetupPlan> {
  const legacyScaffold = await prepareLegacyScaffoldCleanup(context);
  const existing = await operations.readConfig();
  if (classifySelfModificationConfig(existing) === "authored") {
    context.presenter.note(
      `The existing ${DEPLOYED_SELF_MODIFICATION_CONFIG_PATH} contains authored configuration and was not overwritten.`,
      "Manual update required",
      { tone: "warning" },
    );
    return withLegacyScaffold({ kind: "authored" }, legacyScaffold);
  }

  const mode = await context.asker.ask(
    select({
      key: "self-modification-mode",
      message: "How should self-modification be enabled?",
      options: [
        {
          id: "deployed",
          value: "deployed" as const,
          label: "Enable for deployed",
          hint: "Let deployed agents propose source changes through draft pull requests",
        },
        {
          id: "local",
          value: "local" as const,
          label: "Keep local",
          hint: "Only enable source editing during local development",
        },
      ],
      recommended: "local" as const,
      required: true,
    }),
  );
  if (mode === "local") return withLegacyScaffold({ kind: "local" }, legacyScaffold);

  const [project, detected] = await Promise.all([
    context.resolveVercelProject("self-modification"),
    operations.detectGitRepository(),
  ]);
  const owner = await context.asker.ask(
    text({
      key: "self-modification-repository-owner",
      message: "GitHub repository owner",
      detected: detected.owner,
      required: true,
      validate: (value) => validationResult(repositoryOwnerError(value)),
    }),
  );
  const repo = await context.asker.ask(
    text({
      key: "self-modification-repository-name",
      message: "GitHub repository name",
      detected: detected.repo,
      required: true,
      validate: (value) => validationResult(repositoryNameError(value)),
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
    baseBranch: branch,
    connector: `github/${name}`,
    directory,
    repository: `${owner}/${repo}`,
  };
  context.presenter.note(
    renderSelfModificationConfig(values),
    `Generated ${DEPLOYED_SELF_MODIFICATION_CONFIG_PATH}`,
  );
  context.presenter.note(
    "Install the managed GitHub App for only this repository. Repository rules must require review and prevent the connector from bypassing protected branches. Review, merge, and production deployment remain separate operator boundaries.",
    "Security summary",
  );
  context.presenter.note(AUTHORIZATION_WARNING, "Custom authorization recommended", {
    tone: "warning",
  });
  const confirmed = await context.asker.ask(
    confirm({
      key: "self-modification-confirm",
      message: "Create or attach this GitHub connector and write this configuration?",
      recommended: false,
      required: true,
    }),
  );
  return withLegacyScaffold(
    confirmed ? { kind: "deployed", connectorName: name, project, values } : { kind: "local" },
    legacyScaffold,
  );
}

export async function applySelfModificationSetup(
  plan: SelfModificationSetupPlan,
  context: SetupApplyContext,
  operations: SelfModificationSetupOperations = defaultSelfModificationSetupOperations(
    context.appRoot,
    undefined,
    context.projectRoot,
  ),
  deps: SelfModificationApplyDependencies = defaultApplyDependencies,
) {
  if (plan.legacyScaffold !== undefined) {
    await removeLegacySelfModificationScaffold(context.appRoot, plan.legacyScaffold);
    context.presenter.log.success("Removed the retired self-modification scaffold.");
  }
  if (plan.kind === "authored") {
    return {
      facts: [{ label: "Self-modification", value: "manual configuration update required" }],
    };
  }
  if (plan.kind === "local") {
    return { facts: [] };
  }

  const connector = await operations.findOrCreateConnector(plan.connectorName, plan.project);
  await operations.attachConnector(connector, plan.project);
  const packageJsonUpdated = await deps.ensurePackageDependencies({
    dependencies: SELF_MODIFICATION_PRODUCTION_DEPENDENCIES,
    projectRoot: context.appRoot,
  });
  await deps.installScaffoldDependencies({
    changed: packageJsonUpdated.length > 0,
    log: context.presenter.log,
    projectPath: context.appRoot,
    signal: context.signal,
  });
  await operations.writeConfig(renderSelfModificationConfig({ ...plan.values, connector }));
  context.presenter.log.success(`Updated ${DEPLOYED_SELF_MODIFICATION_CONFIG_PATH}.`);
  context.presenter.nextSteps([
    `Replace the allow-all \`authorize\` policy in ${DEPLOYED_SELF_MODIFICATION_CONFIG_PATH} with a custom policy for trusted callers (recommended).`,
    "Install the managed GitHub App for only the configured repository, then deploy or redeploy.",
    "After deployment, request an implementation through the agent's configured channel. It creates source proposals; production setup and deployment remain operator work.",
  ]);
  return {
    deploymentRequired: true as const,
    facts: [
      { label: "Repository", value: plan.values.repository },
      { label: "Application directory", value: plan.values.directory },
      { label: "Target branch", value: plan.values.baseBranch },
      { label: "Credential", value: connector },
    ],
  };
}

export async function prepareLocalSelfModificationSetup(
  context: SetupPrepareContext,
  operations: SelfModificationSetupOperations = defaultSelfModificationSetupOperations(
    context.appRoot,
    undefined,
    context.projectRoot,
  ),
): Promise<SelfModificationSetupPlan> {
  const legacyScaffold = await prepareLegacyScaffoldCleanup(context);
  const existing = await operations.readLocalConfig();
  if (classifySelfModificationConfig(existing) === "authored") {
    context.presenter.note(
      `The existing ${SELF_MODIFICATION_CONFIG_PATH} contains authored configuration and was not overwritten.`,
      "Manual update required",
      { tone: "warning" },
    );
    return withLegacyScaffold({ kind: "authored" }, legacyScaffold);
  }
  return withLegacyScaffold({ kind: "local" }, legacyScaffold);
}

function describeEnvironment(environment: SetupPrepareContext["environment"]): string {
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
}

export const SELF_MODIFICATION_SETUP = defineSetupIntegration({
  kind: "self-modification",
  label: "Self-modification",
  hint: "Local source editing is enabled",
  describeEnvironment,
  prepare: prepareLocalSelfModificationSetup,
  apply: applySelfModificationSetup,
});

export const SELF_MODIFICATION_PRODUCTION_SETUP = defineSetupIntegration({
  kind: "self-modification-production",
  label: "Self-modification production",
  hint: "Configure deployed draft pull requests",
  describeEnvironment,
  prepare: prepareSelfModificationSetup,
  apply: applySelfModificationSetup,
});
