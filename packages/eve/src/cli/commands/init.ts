import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

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
import {
  DEFAULT_EVE_PACKAGE_CONTRACT,
  type EvePackageContract,
} from "#setup/scaffold/create/project.js";

import { initAgentDevHandoff } from "./agent-instructions.js";
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

const CURRENT_DIRECTORY_PROJECT_NAME = ".";
const ALLOWED_CREATE_IN_PLACE_ENTRIES = new Set([".DS_Store", ".git", ".gitkeep", ".hg"]);
export const EVE_INIT_PACKAGE_SPEC_ENV = "EVE_INIT_PACKAGE_SPEC";

/** Resolves `target` to an existing directory, or undefined for name mode. */
async function resolveTargetDirectory(
  parentDirectory: string,
  target: string,
): Promise<string | undefined> {
  const targetPath = resolve(parentDirectory, target);
  const stats = await stat(targetPath).catch(() => undefined);
  return stats?.isDirectory() ? targetPath : undefined;
}

function isCurrentDirectoryTarget(target: string): boolean {
  return /^\.(?:[/\\]+\.?)*$/u.test(target.trim());
}

async function assertCanScaffoldInPlace(targetRoot: string): Promise<void> {
  const entries = await readdir(targetRoot);
  const blocking = entries.filter((entry) => !ALLOWED_CREATE_IN_PLACE_ENTRIES.has(entry));
  if (blocking.length === 0) {
    return;
  }

  const visible = blocking.slice(0, 5).join(", ");
  const suffix = blocking.length > 5 ? `, and ${blocking.length - 5} more` : "";
  throw new Error(
    `Cannot create project in current directory because it is not empty. Found: ${visible}${suffix}. Use an empty directory.`,
  );
}

async function moveDirectoryContents(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const entry of await readdir(sourceRoot)) {
    await rename(join(sourceRoot, entry), join(targetRoot, entry));
  }
}

/**
 * Adds the agent to an existing project and returns the
 * detected manager, which drives the install and dev handoff.
 */
async function addToExistingProject(
  targetPath: string,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies,
  evePackage: EvePackageContract | undefined,
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
    evePackage,
  });
  return {
    packageManager: manager.kind,
    nodeEngineOverride: result.nodeEngineOverride,
  };
}

/**
 * The manager a fresh scaffold will be owned by: an existing ancestor project
 * manager first, then the package runner that launched the CLI, then pnpm.
 */
async function resolveScaffoldPackageManager(
  projectPath: string,
  dependencies: InitCommandDependencies,
): Promise<PackageManagerKind> {
  const detected = await dependencies.detectPackageManager(projectPath);
  if (detected.source !== "default") {
    return detected.kind;
  }
  return dependencies.detectInvokingPackageManager() ?? "pnpm";
}

async function scaffoldProject(
  parentDirectory: string,
  projectName: string,
  packageManager: PackageManagerKind,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies,
  evePackage: EvePackageContract | undefined,
): Promise<string> {
  const parentPath = resolve(parentDirectory);
  const createInPlace = projectName === CURRENT_DIRECTORY_PROJECT_NAME;
  const projectPath = createInPlace ? parentPath : join(parentPath, projectName);
  if (createInPlace) {
    await assertCanScaffoldInPlace(projectPath);
  } else if (await pathExists(projectPath)) {
    throw new Error(`Cannot create project because "${projectPath}" already exists.`);
  }

  const stagingDirectory = await mkdtemp(join(parentPath, ".eve-init-"));
  try {
    const stagedProjectName = createInPlace ? basename(projectPath) : projectName;
    const scaffoldOptions = {
      projectName: stagedProjectName,
      model: DEFAULT_AGENT_MODEL_ID,
      evePackage,
      targetDirectory: stagingDirectory,
      packageManager,
    };
    const stagedProjectPath = await dependencies.scaffoldBaseProject(scaffoldOptions);

    if (options.channelWebNextjs === true) {
      await dependencies.ensureChannel({
        projectRoot: stagedProjectPath,
        kind: "web",
        packageManager,
        configureVercelServices: false,
      });
    }

    if (createInPlace) {
      await moveDirectoryContents(stagedProjectPath, projectPath);
    } else {
      await rename(stagedProjectPath, projectPath);
    }
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
 * Creates a new eve agent (`target` is a project name), or adds one to an
 * existing project (`target` is a directory), without prompts or external
 * provisioning.
 *
 * Runs launched by a coding agent get the dev command printed instead of
 * spawned after scaffolding, since the dev TUI would wedge the launching agent.
 */
export async function runInitCommand(
  logger: InitCliLogger,
  parentDirectory: string,
  target: string | undefined,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies = defaultDependencies,
): Promise<void> {
  const agentLaunched = await dependencies.isCodingAgentLaunch();
  const rawTarget = target ?? CURRENT_DIRECTORY_PROJECT_NAME;
  const evePackage = resolveInitEvePackageOverride();
  const currentDirectoryTarget = isCurrentDirectoryTarget(rawTarget);
  const existingDirectory = currentDirectoryTarget
    ? (await pathExists(join(resolve(parentDirectory), "package.json")))
      ? resolve(parentDirectory)
      : undefined
    : await resolveTargetDirectory(parentDirectory, rawTarget);

  // A fresh project inside a workspace inherits that workspace's manager before
  // considering the launcher (`npx`, `pnpm dlx`, `yarn dlx`); an existing
  // project keeps whatever manager it already uses.
  let packageManager: PackageManagerKind;
  let projectPath: string;
  let freshScaffold: boolean;
  if (existingDirectory === undefined) {
    const projectName = currentDirectoryTarget
      ? CURRENT_DIRECTORY_PROJECT_NAME
      : parseProjectName(rawTarget);
    const parentPath = resolve(parentDirectory);
    const plannedProjectPath =
      projectName === CURRENT_DIRECTORY_PROJECT_NAME ? parentPath : join(parentPath, projectName);
    packageManager = await resolveScaffoldPackageManager(plannedProjectPath, dependencies);
    projectPath = await scaffoldProject(
      parentDirectory,
      projectName,
      packageManager,
      options,
      dependencies,
      evePackage,
    );
    freshScaffold = true;
    logger.log(`${pc.green("✓")} Created an ${EVE_WORDMARK} agent in ${pc.bold(projectPath)}`);
  } else {
    const addition = await addToExistingProject(
      existingDirectory,
      options,
      dependencies,
      evePackage,
    );
    packageManager = addition.packageManager;
    projectPath = existingDirectory;
    freshScaffold = false;
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
  if (freshScaffold) {
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
  const devArguments = freshScaffold
    ? [...eveDevArguments(packageManager), "--input", "/model"]
    : eveDevArguments(packageManager);
  logger.log(pc.dim(freshScaffold ? "$ eve dev --input /model" : "$ eve dev"));
  if (!(await dependencies.spawnPackageManager(packageManager, projectPath, devArguments))) {
    throw new Error(`Development server exited unsuccessfully in "${projectPath}".`);
  }
}

function resolveInitEvePackageOverride(): EvePackageContract | undefined {
  const spec = process.env[EVE_INIT_PACKAGE_SPEC_ENV]?.trim();
  if (spec === undefined || spec.length === 0) {
    return undefined;
  }

  return {
    nodeEngine: DEFAULT_EVE_PACKAGE_CONTRACT.nodeEngine,
    version: spec,
  };
}
