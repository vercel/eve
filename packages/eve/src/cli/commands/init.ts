import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import pc from "picocolors";

import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import { EVE_WORDMARK } from "#cli/banner.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createLogger, isLogLevelEnabled } from "#internal/logging.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
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
import type { ProcessOutputLine } from "#setup/primitives/process-output.js";
import { addAgentToProject } from "#setup/scaffold/create/add-to-project.js";
import { ensureChannel, scaffoldBaseProject } from "#setup/scaffold/index.js";
import {
  DEFAULT_EVE_PACKAGE_CONTRACT,
  type EvePackageContract,
} from "#setup/scaffold/create/project.js";

import { initAgentDevHandoff } from "./agent-instructions.js";
import { tryInitializeGit, type GitInitResult } from "./init-git.js";

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
  now: () => number;
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
  now: () => performance.now(),
  runPackageManagerInstall,
  scaffoldBaseProject,
  spawnPackageManager,
  tryInitializeGit,
};

const CURRENT_DIRECTORY_PROJECT_NAME = ".";
const ALLOWED_CREATE_IN_PLACE_ENTRIES = new Set([".DS_Store", ".git", ".gitkeep", ".hg"]);
export const EVE_INIT_PACKAGE_SPEC_ENV = "EVE_INIT_PACKAGE_SPEC";

const initLog = createLogger("init");

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

type PreparedInitProject =
  | {
      kind: "added";
      nodeEngineOverride?: NodeEngineOverride;
      packageManager: PackageManagerKind;
      projectPath: string;
    }
  | {
      kind: "created";
      packageManager: PackageManagerKind;
      projectPath: string;
    };

type InitResult = {
  agentElapsedMs: number;
  agentLaunched: boolean;
  installElapsedMs: number;
  packageManager: PackageManagerKind;
  projectPath: string;
} & (
  | {
      kind: "added";
      nodeEngineOverride?: NodeEngineOverride;
    }
  | {
      gitResult: GitInitResult;
      kind: "created";
    }
);

function installProgressDetail(
  packageManager: PackageManagerKind,
  line: ProcessOutputLine,
): string | undefined {
  const text = line.text.trim();
  if (text === "" || packageManager !== "npm") return text || undefined;

  const manifest = /^npm silly fetch manifest (.+)$/u.exec(text);
  if (manifest !== null) return `Resolving ${manifest[1]}`;

  const failedRequest = /^npm http fetch \S+ \S+ attempt (\d+) failed with (\S+)$/u.exec(text);
  if (failedRequest !== null) {
    return `npm registry · attempt ${failedRequest[1]} failed: ${failedRequest[2]}`;
  }

  if (line.stream === "stdout" || /^npm (?:error|warn)\b/u.test(text)) return text;
  return undefined;
}

const NPM_NOISE_LINE = /^\s*npm (?:silly|verbose|http|timing)\b/u;
const INSTALL_OUTPUT_FALLBACK_LINES = 20;

async function runInitSteps(input: {
  dependencies: InitCommandDependencies;
  logger: InitCliLogger;
  options: InitCommandOptions;
  parentDirectory: string;
  target: string | undefined;
}): Promise<InitResult> {
  const { dependencies, logger, options, parentDirectory, target } = input;
  const debug = isLogLevelEnabled("debug");
  const progress = startCliLiveRow(logger);
  progress.update("Preparing project");

  try {
    const agentLaunched = await dependencies.isCodingAgentLaunch();
    const rawTarget = target ?? CURRENT_DIRECTORY_PROJECT_NAME;
    const currentDirectoryTarget = isCurrentDirectoryTarget(rawTarget);
    const existingDirectory = currentDirectoryTarget
      ? (await pathExists(join(resolve(parentDirectory), "package.json")))
        ? resolve(parentDirectory)
        : undefined
      : await resolveTargetDirectory(parentDirectory, rawTarget);
    const evePackage = resolveInitEvePackageOverride();

    const scaffoldPhase = existingDirectory === undefined ? "creating agent" : "adding agent";
    progress.update(existingDirectory === undefined ? "Creating agent" : "Adding agent");
    initLog.debug(scaffoldPhase);
    const agentStartedAt = dependencies.now();
    let project: PreparedInitProject;
    if (existingDirectory === undefined) {
      const projectName = currentDirectoryTarget
        ? CURRENT_DIRECTORY_PROJECT_NAME
        : parseProjectName(rawTarget);
      const parentPath = resolve(parentDirectory);
      const plannedProjectPath =
        projectName === CURRENT_DIRECTORY_PROJECT_NAME ? parentPath : join(parentPath, projectName);
      const packageManager = await resolveScaffoldPackageManager(plannedProjectPath, dependencies);
      const projectPath = await scaffoldProject(
        parentDirectory,
        projectName,
        packageManager,
        options,
        dependencies,
        evePackage,
      );
      project = { kind: "created", packageManager, projectPath };
    } else {
      const addition = await addToExistingProject(existingDirectory, options, dependencies, evePackage);
      project =
        addition.nodeEngineOverride === undefined
          ? {
              kind: "added",
              packageManager: addition.packageManager,
              projectPath: existingDirectory,
            }
          : {
              kind: "added",
              nodeEngineOverride: addition.nodeEngineOverride,
              packageManager: addition.packageManager,
              projectPath: existingDirectory,
            };
    }
    const agentElapsedMs = dependencies.now() - agentStartedAt;
    initLog.debug(`${scaffoldPhase} done`, { ms: agentElapsedMs });

    progress.update("Installing dependencies", `${project.packageManager} install`);
    initLog.debug(`installing dependencies with ${project.packageManager}`);
    const installStartedAt = dependencies.now();
    const installFailureOutput: string[] = [];
    const recentInstallOutput: string[] = [];
    const installed = await dependencies.runPackageManagerInstall(
      project.packageManager,
      project.projectPath,
      {
        // The scaffold pins versions younger than typical release-age cooldown
        // windows; gating them would fail every fresh bootstrap.
        bypassMinimumReleaseAge: true,
        progressDetails: process.stdout.isTTY === true && !debug,
        onOutput: (line) => {
          if (line.text.trim() !== "") {
            recentInstallOutput.push(line.text);
            if (recentInstallOutput.length > INSTALL_OUTPUT_FALLBACK_LINES) {
              recentInstallOutput.shift();
            }
            if (!NPM_NOISE_LINE.test(line.text)) {
              installFailureOutput.push(line.text);
            }
          }
          if (debug) initLog.debug(line.text);
          const detail = installProgressDetail(project.packageManager, line);
          if (detail !== undefined) progress.update("Installing dependencies", detail);
        },
      },
    );
    const installElapsedMs = dependencies.now() - installStartedAt;
    if (!installed) {
      initLog.debug("dependency installation failed", { ms: installElapsedMs });
      progress.stop();
      const failureOutput =
        installFailureOutput.length > 0 ? installFailureOutput : recentInstallOutput;
      for (const line of failureOutput) logger.error(line);
      throw new Error(`Failed to install dependencies in "${project.projectPath}".`);
    }
    initLog.debug("dependencies installed", { ms: installElapsedMs });

    if (project.kind === "created") {
      progress.update("Initializing Git repository");
      initLog.debug("initializing git repository");
      return {
        ...project,
        agentElapsedMs,
        agentLaunched,
        gitResult: await dependencies.tryInitializeGit(project.projectPath),
        installElapsedMs,
      };
    }

    return { ...project, agentElapsedMs, agentLaunched, installElapsedMs };
  } finally {
    progress.stop();
  }
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
  const result = await runInitSteps({ dependencies, logger, options, parentDirectory, target });
  const freshScaffold = result.kind === "created";

  if (result.kind === "created") {
    logger.log(
      `${pc.green("✓")} Created an ${EVE_WORDMARK} agent in ${pc.bold(result.projectPath)} ${pc.dim(`in ${formatElapsed(result.agentElapsedMs)}`)}`,
    );
  } else {
    logger.log(
      `${pc.green("✓")} Added an ${EVE_WORDMARK} agent to ${pc.bold(result.projectPath)} ${pc.dim(`in ${formatElapsed(result.agentElapsedMs)}`)}`,
    );
    if (result.nodeEngineOverride !== undefined) {
      logger.log(pc.yellow(`⚠ ${formatNodeEngineOverrideWarning(result.nodeEngineOverride)}`));
    }
  }
  logger.log(
    `${pc.green("✓")} Installed dependencies ${pc.dim(`in ${formatElapsed(result.installElapsedMs)}`)}`,
  );

  if (result.kind === "created" && result.gitResult.kind === "failed") {
    logger.error(pc.yellow(`Git initialization failed: ${result.gitResult.reason}`));
  }

  if (result.agentLaunched) {
    logger.log(
      initAgentDevHandoff({
        projectPath: result.projectPath,
        devCommand: [result.packageManager, ...eveDevArguments(result.packageManager)].join(" "),
      }),
    );
    return;
  }

  // Strictly the eve binary, never the project's dev script, which in an
  // existing app may start unrelated processes. Exec-style runs do not echo
  // the command the way run-scripts do, so the handoff line is printed here.
  const devArguments = freshScaffold
    ? [...eveDevArguments(result.packageManager), "--input", "/model"]
    : eveDevArguments(result.packageManager);
  logger.log(pc.dim(freshScaffold ? "$ eve dev --input /model" : "$ eve dev"));
  if (
    !(await dependencies.spawnPackageManager(
      result.packageManager,
      result.projectPath,
      devArguments,
    ))
  ) {
    throw new Error(`Development server exited unsuccessfully in "${result.projectPath}".`);
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
