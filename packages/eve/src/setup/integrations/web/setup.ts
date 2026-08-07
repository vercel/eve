import { detectPackageManager } from "#setup/package-manager.js";
import { formatNodeEngineOverrideWarning } from "#setup/node-engine.js";
import { ensureChannel, type EnsureChannelOptions } from "#setup/scaffold/index.js";

import { installScaffoldDependencies, reportOverwrittenFiles } from "../shared/scaffold.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

function reportCompetingNextConfigFiles(
  log: Parameters<typeof reportOverwrittenFiles>[0],
  files: readonly string[] | undefined,
): void {
  for (const filePath of files ?? []) {
    log.warning(
      `Found competing Next.js config at ${filePath}; merge any needed settings into next.config.ts and remove it before starting the preview, or Next.js may ignore the generated eve rewrite.`,
    );
  }
}

export interface WebSetupDeps {
  detectPackageManager: typeof detectPackageManager;
  ensureChannel: typeof ensureChannel;
  installScaffoldDependencies: typeof installScaffoldDependencies;
}

const defaultDeps: WebSetupDeps = {
  detectPackageManager,
  ensureChannel,
  installScaffoldDependencies,
};

export interface WebSetupPlan {
  configureVercelServices: boolean;
  packageManager: Awaited<ReturnType<typeof detectPackageManager>>["kind"];
}

export async function prepareWebSetup(
  context: SetupPrepareContext,
  deps: WebSetupDeps = defaultDeps,
): Promise<WebSetupPlan> {
  return {
    packageManager: (await deps.detectPackageManager(context.appRoot)).kind,
    configureVercelServices: context.environment.vercel.kind === "available",
  };
}

export async function applyWebSetup(
  plan: WebSetupPlan,
  context: SetupApplyContext,
  deps: WebSetupDeps = defaultDeps,
) {
  context.presentation.log.message("Scaffolding Web Chat channel files...");
  const options: EnsureChannelOptions = {
    projectRoot: context.appRoot,
    kind: "web",
    packageManager: plan.packageManager,
    configureVercelServices: plan.configureVercelServices,
    force: context.force,
    skipDependencyMutation: true,
  };
  const result = await deps.ensureChannel(options);
  reportOverwrittenFiles(context.presentation.log, result.filesOverwritten);
  if (
    result.kind === "web" &&
    result.action !== "skipped" &&
    result.nodeEngineOverride !== undefined
  ) {
    context.presentation.log.warning(formatNodeEngineOverrideWarning(result.nodeEngineOverride));
  }
  reportCompetingNextConfigFiles(
    context.presentation.log,
    "competingNextConfigFiles" in result ? result.competingNextConfigFiles : undefined,
  );
  if (result.action === "skipped") {
    context.presentation.log.info("Next.js project detected. Skipping Web Chat scaffolding.");
    return { facts: [] };
  }
  context.presentation.log.success("Scaffolded channel: web");
  await deps.installScaffoldDependencies({
    changed: result.packageJsonUpdated.length > 0,
    log: context.presentation.log,
    projectPath: context.appRoot,
    signal: context.signal,
  });
  return { facts: [], deploymentRequired: true as const };
}

export const WEB_SETUP = defineSetupIntegration({
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  prepare: prepareWebSetup,
  apply: applyWebSetup,
});
