import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";

/** Effects used to install dependencies added by an integration scaffold. */
export interface IntegrationScaffoldDeps {
  detectPackageManager: typeof detectPackageManager;
  runPackageManagerInstall: typeof runPackageManagerInstall;
}

const defaultDeps: IntegrationScaffoldDeps = { detectPackageManager, runPackageManagerInstall };

/** Installs dependencies added by an integration scaffold without failing setup if installation fails. */
export async function installScaffoldDependencies(input: {
  changed: boolean;
  log: ChannelSetupLog;
  projectPath: string;
  signal?: AbortSignal;
  skip?: boolean;
  deps?: IntegrationScaffoldDeps;
}): Promise<void> {
  if (!input.changed || input.skip) return;
  const deps = input.deps ?? defaultDeps;
  const packageManager = await deps.detectPackageManager(input.projectPath);
  const installed = await withPhase(
    input.log,
    `Installing channel dependencies (${packageManager.kind} install)...`,
    () =>
      deps.runPackageManagerInstall(packageManager.kind, input.projectPath, {
        onOutput: createPromptCommandOutput(input.log),
        signal: input.signal,
      }),
  );
  if (installed) return;
  input.log.warning(
    `Dependency installation failed. The new channel stays unloadable until \`${packageManager.kind} install\` or a deploy succeeds.`,
  );
}

/** Reports files overwritten by one integration scaffold. */
export function reportOverwrittenFiles(
  log: ChannelSetupLog,
  files: readonly string[] | undefined,
): void {
  for (const filePath of files ?? []) log.warning(`Overwrote ${filePath}`);
}
