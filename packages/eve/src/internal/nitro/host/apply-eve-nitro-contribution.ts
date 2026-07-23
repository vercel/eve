import { join } from "node:path";

import type { Nitro } from "nitro/types";

import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { createProductionNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import {
  applyPreparedDevelopmentNitroRoutes,
  applyPreparedProductionNitroRoutes,
  prepareDevelopmentNitroRoutes,
  prepareProductionNitroRoutes,
} from "#internal/nitro/host/configure-nitro-routes.js";
import {
  addNitroStepNoExternals,
  configureEveNitroBundlerHooks,
  configureEveNitroStepHooks,
  externalizeDevelopmentWorkflowBundle,
} from "#internal/nitro/host/eve-nitro-bundler-hooks.js";
import type { EveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";
import { registerScheduleTaskHandlers } from "#internal/nitro/host/schedule-task-routes.js";

/**
 * Configures a newly-created standalone development candidate before Nitro/Vite
 * initializes its runtime handlers.
 *
 * Authored route-topology changes must replace the candidate. Calling
 * `routing.sync()` on an initialized Nitro/Vite runtime is not a supported
 * topology-replacement lifecycle.
 */
export async function configureInitialStandaloneDevelopmentEveNitroContribution(
  nitro: Nitro,
  contribution: EveNitroContribution<"development">,
): Promise<void> {
  const preparedRoutes = await prepareDevelopmentNitroRoutes(nitro, contribution.preparedHost);
  const stepEntrypointPath = join(nitro.options.buildDir, "workflow", "steps.mjs");
  await addNitroStepNoExternals(nitro, stepEntrypointPath);

  configureEveNitroBundlerHooks(nitro, contribution);
  const clearStepTransformCaches = configureEveNitroStepHooks(nitro, stepEntrypointPath);
  nitro.hooks.hook("dev:reload", () => {
    for (const clearCache of clearStepTransformCaches) {
      clearCache();
    }
  });
  externalizeDevelopmentWorkflowBundle(nitro, contribution);
  applyPreparedDevelopmentNitroRoutes(nitro, preparedRoutes);
}

export async function applyProductionEveNitroContribution(
  nitro: Nitro,
  contribution: EveNitroContribution<"production">,
): Promise<void> {
  const preparedRoutes = await prepareProductionNitroRoutes(
    nitro,
    contribution.preparedHost,
    contribution.surface,
  );
  const stepEntrypointPath = join(contribution.preparedHost.workflowBuildDir, "steps.mjs");
  if (contribution.workflowRoutes) {
    await addNitroStepNoExternals(nitro, stepEntrypointPath);
  }

  configureEveNitroBundlerHooks(nitro, contribution);
  if (contribution.workflowRoutes) {
    configureEveNitroStepHooks(nitro, stepEntrypointPath);
  }

  if (
    contribution.applicationRoutes &&
    contribution.preparedHost.scheduleRegistrations.length > 0
  ) {
    registerScheduleTaskHandlers(nitro, {
      artifactsConfig: createProductionNitroArtifactsConfig(),
      dispatchModulePath: resolvePackageSourceFilePath(
        "src/internal/nitro/routes/schedule-task.ts",
      ),
      registrations: contribution.preparedHost.scheduleRegistrations,
    });
  }

  applyPreparedProductionNitroRoutes(nitro, preparedRoutes);
}
