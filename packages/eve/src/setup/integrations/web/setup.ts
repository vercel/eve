import { detectPackageManager } from "#setup/package-manager.js";
import { formatNodeEngineOverrideWarning } from "#setup/node-engine.js";
import { ensureChannel, type EnsureChannelOptions } from "#setup/scaffold/index.js";

import { installScaffoldDependencies, reportOverwrittenFiles } from "../shared/scaffold.js";
import type { SetupIntegration } from "../types.js";

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

/** Web Chat scaffolding. */
export const WEB_SETUP: SetupIntegration = {
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  async setup(context) {
    context.ui.prompter.log.message("Scaffolding Web Chat channel files...");
    const options: EnsureChannelOptions = {
      projectRoot: context.appRoot,
      kind: "web",
      packageManager: (await detectPackageManager(context.appRoot)).kind,
      configureVercelServices: context.environment.vercel.kind === "available",
      force: context.force,
      skipDependencyMutation: true,
    };
    const result = await ensureChannel(options);
    reportOverwrittenFiles(context.ui.prompter.log, result.filesOverwritten);
    if (
      result.kind === "web" &&
      result.action !== "skipped" &&
      result.nodeEngineOverride !== undefined
    ) {
      context.ui.prompter.log.warning(formatNodeEngineOverrideWarning(result.nodeEngineOverride));
    }
    reportCompetingNextConfigFiles(
      context.ui.prompter.log,
      "competingNextConfigFiles" in result ? result.competingNextConfigFiles : undefined,
    );
    if (result.action === "skipped") {
      context.ui.prompter.log.info("Next.js project detected. Skipping Web Chat scaffolding.");
      return { kind: "done" };
    }
    context.ui.prompter.log.success("Scaffolded channel: web");
    await installScaffoldDependencies({
      changed: result.packageJsonUpdated.length > 0,
      log: context.ui.prompter.log,
      projectPath: context.appRoot,
      signal: context.signal,
    });
    return { kind: "done" };
  },
};
