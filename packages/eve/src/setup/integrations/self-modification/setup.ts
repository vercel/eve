import { relative } from "node:path";

import { confirm, select, text } from "#setup/ask.js";
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
import {
  detectLegacySelfModificationScaffold,
  removeLegacySelfModificationScaffold,
  type LegacySelfModificationScaffold,
} from "#self-modification/migration.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { ensurePackageDependencies } from "#setup/scaffold/index.js";
import {
  DEFAULT_CONNECT_PACKAGE_VERSION,
  DEFAULT_MICROSANDBOX_PACKAGE_VERSION,
} from "#setup/scaffold/version-tokens.js";

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
  "@vercel/connect": DEFAULT_CONNECT_PACKAGE_VERSION,
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
      `The existing ${SELF_MODIFICATION_CONFIG_PATH} contains authored configuration and was not overwritten.`,
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

  const [project, detected, channelNames] = await Promise.all([
    context.resolveVercelProject("self-modification"),
    operations.detectGitRepository(),
    operations.detectChannelNames(),
  ]);
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
    channelNames,
    connector: `github/${name}`,
    directory,
    repository: `github.com/${owner}/${repo}`,
    vercelBackend: true,
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
  context.presenter.log.success(`Updated ${SELF_MODIFICATION_CONFIG_PATH}.`);
  context.presenter.nextSteps([
    "Install the managed GitHub App for the configured repository, then deploy or redeploy.",
    plan.values.vercelBackend
      ? "After deployment, try self-modification by running `eve dev <deployment-url>` from this linked project. The generated policy admits its Vercel OIDC identity over HTTP; configured channels remain denied until you update `agent/extensions/self-modification/extension.ts`."
      : "Before deployment, configure `deployed.authorize` in `agent/extensions/self-modification/extension.ts` to admit a trusted principal for your deployment's channel. After deployment, use that channel to try self-modification.",
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

export async function prepareLocalSelfModificationSetup(
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
