import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import pc from "picocolors";

import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import { EVE_WORDMARK } from "#cli/banner.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import { SPINNER_FRAME_MS, SPINNER_FRAMES } from "#setup/cli/rail-log.js";
import { formatNodeEngineOverrideWarning, type NodeEngineOverride } from "#setup/node-engine.js";
import {
  detectInvokingPackageManager,
  detectPackageManager,
  type PackageManagerKind,
} from "#setup/package-manager.js";
import { pathExists } from "#setup/path-exists.js";
import { parseProjectName } from "#setup/project-name.js";
import {
  eveDevArguments,
  runPackageManagerInstall,
  spawnPackageManager,
} from "#setup/primitives/index.js";
import { addAgentToProject } from "#setup/scaffold/create/add-to-project.js";
import { ensureChannel, scaffoldBaseProject } from "#setup/scaffold/index.js";

import { initAgentDevHandoff, initAgentInstructions } from "./agent-instructions.js";
import { tryInitializeGit } from "./init-git.js";

export interface InitCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface InitCommandOptions {
  /** Add the Web Chat channel (a Next.js app). Set by `--channel-web-nextjs`. */
  channelWebNextjs?: boolean;
}

export interface InitCommandDependencies {
  addAgentToProject: typeof addAgentToProject;
  detectInvokingPackageManager: typeof detectInvokingPackageManager;
  detectPackageManager: typeof detectPackageManager;
  ensureChannel: typeof ensureChannel;
  isCodingAgentLaunch: typeof isCodingAgentLaunch;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  scaffoldBaseProject: typeof scaffoldBaseProject;
  spawnPackageManager: typeof spawnPackageManager;
  tryInitializeGit: typeof tryInitializeGit;
}

const defaultDependencies: InitCommandDependencies = {
  addAgentToProject,
  detectInvokingPackageManager,
  detectPackageManager,
  ensureChannel,
  isCodingAgentLaunch,
  runPackageManagerInstall,
  scaffoldBaseProject,
  spawnPackageManager,
  tryInitializeGit,
};

/** Resolves `target` to an existing directory, or undefined for name mode. */
async function resolveTargetDirectory(
  parentDirectory: string,
  target: string,
): Promise<string | undefined> {
  const targetPath = resolve(parentDirectory, target);
  const stats = await stat(targetPath).catch(() => undefined);
  return stats?.isDirectory() ? targetPath : undefined;
}

/**
 * Adds the agent to an existing project and returns the
 * detected manager, which drives the install and dev handoff.
 */
async function addToExistingProject(
  targetPath: string,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies,
): Promise<{ packageManager: PackageManagerKind; nodeEngineOverride?: NodeEngineOverride }> {
  if (options.channelWebNextjs === true) {
    throw new Error(
      "`--channel-web-nextjs` is not supported when adding an agent to an existing project. " +
        "Run `eve channels add web` from the project afterwards instead.",
    );
  }

  const manager = await dependencies.detectPackageManager(targetPath);
  const result = await dependencies.addAgentToProject({
    projectRoot: targetPath,
    model: DEFAULT_AGENT_MODEL_ID,
    packageManager: manager.kind,
  });
  return {
    packageManager: manager.kind,
    nodeEngineOverride: result.nodeEngineOverride,
  };
}

/**
 * The manager a fresh scaffold will be owned by: the one whose package runner
 * launched the CLI, or pnpm when the binary ran directly and no preference
 * is visible.
 */
function resolveScaffoldPackageManager(dependencies: InitCommandDependencies): PackageManagerKind {
  return dependencies.detectInvokingPackageManager() ?? "pnpm";
}

const PACKAGE_RUNNERS: Record<PackageManagerKind, string> = {
  bun: "bunx",
  npm: "npx",
  pnpm: "pnpm dlx",
  yarn: "yarn dlx",
};

function resolveInitCommand(dependencies: InitCommandDependencies): string {
  const manager = dependencies.detectInvokingPackageManager();
  return manager === undefined ? "eve init" : `${PACKAGE_RUNNERS[manager]} eve init`;
}

async function scaffoldProject(
  parentDirectory: string,
  projectName: string,
  packageManager: PackageManagerKind,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies,
): Promise<string> {
  const parentPath = resolve(parentDirectory);
  const projectPath = join(parentPath, projectName);
  if (await pathExists(projectPath)) {
    throw new Error(`Cannot create project because "${projectPath}" already exists.`);
  }

  const stagingDirectory = await mkdtemp(join(parentPath, ".eve-init-"));
  try {
    const stagedProjectPath = await dependencies.scaffoldBaseProject({
      projectName,
      model: DEFAULT_AGENT_MODEL_ID,
      packageManager,
      targetDirectory: stagingDirectory,
    });

    if (options.channelWebNextjs === true) {
      await dependencies.ensureChannel({
        projectRoot: stagedProjectPath,
        kind: "web",
        packageManager,
        configureVercelServices: false,
      });
    }

    await rename(stagedProjectPath, projectPath);
    return projectPath;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * A spinner is purely a liveness affordance, so it draws only on a TTY; piped
 * output gets the pending message once and never sees redraw control codes.
 */
function startSpinner(logger: InitCliLogger, message: string): { stop(): void } {
  if (process.stdout.isTTY !== true) {
    logger.log(message);
    return { stop() {} };
  }

  const row = (glyph: string): string => `${pc.green(glyph)} ${message}`;
  process.stdout.write(row(SPINNER_FRAMES[0]));
  let frame = 0;
  const timer = setInterval(() => {
    frame += 1;
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
    process.stdout.write(`\r\u001B[K${row(glyph)}`);
  }, SPINNER_FRAME_MS);
  timer.unref?.();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stdout.write("\r\u001B[K");
    },
  };
}

/**
 * Creates a new Eve agent (`target` is a project name), or adds one to an
 * existing project (`target` is a directory), without prompts or external
 * provisioning.
 *
 * Runs launched by a coding agent diverge twice: with no `target` they get the
 * recipe for collecting one from the user instead of a scaffold under an
 * invented name, and after scaffolding they get the dev command printed
 * instead of spawned, since the dev TUI would wedge the launching agent.
 */
export async function runInitCommand(
  logger: InitCliLogger,
  parentDirectory: string,
  target: string | undefined,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies = defaultDependencies,
): Promise<void> {
  const agentLaunched = await dependencies.isCodingAgentLaunch();
  if (target === undefined) {
    if (agentLaunched) {
      logger.log(
        initAgentInstructions({
          initCommand: resolveInitCommand(dependencies),
        }),
      );
      return;
    }
    // `target` is optional only so the agent path above can run; a human
    // omitting it gets the same error commander raised when it was required.
    throw new Error("missing required argument 'target'");
  }

  const existingDirectory = await resolveTargetDirectory(parentDirectory, target);

  // A fresh project is owned by the manager that launched the CLI (`npx`,
  // `pnpm dlx`, `yarn dlx`), defaulting to pnpm for a direct binary run; an
  // existing project keeps whatever manager it already uses.
  let packageManager: PackageManagerKind;
  let projectPath: string;
  if (existingDirectory === undefined) {
    packageManager = resolveScaffoldPackageManager(dependencies);
    const projectName = parseProjectName(target);
    projectPath = await scaffoldProject(
      parentDirectory,
      projectName,
      packageManager,
      options,
      dependencies,
    );
    logger.log(`${pc.green("✓")} Created an ${EVE_WORDMARK} agent in ${pc.bold(projectPath)}`);
  } else {
    const addition = await addToExistingProject(existingDirectory, options, dependencies);
    packageManager = addition.packageManager;
    projectPath = existingDirectory;
    logger.log(`${pc.green("✓")} Added an ${EVE_WORDMARK} agent to ${pc.bold(projectPath)}`);
    if (addition.nodeEngineOverride !== undefined) {
      logger.log(pc.yellow(`⚠ ${formatNodeEngineOverrideWarning(addition.nodeEngineOverride)}`));
    }
  }

  // Install output is elided behind the spinner; it is replayed only when the
  // install fails, so the user sees the manager's diagnostics exactly when
  // relevant.
  const installLog: string[] = [];
  const spinner = startSpinner(logger, "Installing dependencies...");
  let installed: boolean;
  try {
    installed = await dependencies.runPackageManagerInstall(packageManager, projectPath, {
      // The scaffold pins versions younger than typical release-age cooldown
      // windows; gating them would fail every fresh bootstrap.
      bypassMinimumReleaseAge: true,
      onOutput: (line) => installLog.push(line.text),
    });
  } finally {
    spinner.stop();
  }
  if (!installed) {
    for (const line of installLog) {
      logger.error(line);
    }
    throw new Error(`Failed to install dependencies in "${projectPath}".`);
  }
  logger.log(`${pc.green("✓")} Installed dependencies`);

  // Git is initialized only for a freshly created project; an existing
  // project's history is its own.
  if (existingDirectory === undefined) {
    const gitResult = dependencies.tryInitializeGit(projectPath);
    if (gitResult.kind === "failed") {
      logger.error(pc.yellow(`Git initialization failed: ${gitResult.reason}`));
    }
  }

  if (agentLaunched) {
    logger.log(
      initAgentDevHandoff({
        projectPath,
        devCommand: [packageManager, ...eveDevArguments(packageManager)].join(" "),
      }),
    );
    return;
  }

  // Strictly the eve binary, never the project's dev script, which in an
  // existing app may start unrelated processes. Exec-style runs do not echo
  // the command the way run-scripts do, so the handoff line is printed here.
  const freshScaffold = existingDirectory === undefined;
  const devArguments = freshScaffold
    ? [...eveDevArguments(packageManager), "--input", "/model"]
    : eveDevArguments(packageManager);
  logger.log(pc.dim(freshScaffold ? "$ eve dev --input /model" : "$ eve dev"));
  if (!(await dependencies.spawnPackageManager(packageManager, projectPath, devArguments))) {
    throw new Error(`Development server exited unsuccessfully in "${projectPath}".`);
  }
}
