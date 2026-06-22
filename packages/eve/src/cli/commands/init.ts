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
import { WizardCancelledError } from "#setup/step.js";
import type { WorkspaceRootMutation } from "#setup/scaffold/workspace-root.js";
import {
  DEFAULT_EVE_PACKAGE_CONTRACT,
  type EvePackageContract,
} from "#setup/scaffold/create/project.js";

import {
  initAgentDevHandoff,
  initAgentInstructions,
  initAgentReplPrompt,
} from "./agent-instructions.js";
import { tryInitializeGit, type GitInitResult } from "./init-git.js";
import { selectInitHandoff, spawnCodingAgentRepl, type InitHandoff } from "./init-repl.js";

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
  selectInitHandoff: typeof selectInitHandoff;
  spawnCodingAgentRepl: typeof spawnCodingAgentRepl;
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
  selectInitHandoff,
  spawnCodingAgentRepl,
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

function uniqueWorkspaceRootMutations(
  mutations: readonly WorkspaceRootMutation[],
): WorkspaceRootMutation[] {
  const byKey = new Map<string, WorkspaceRootMutation>();
  for (const mutation of mutations) {
    const key = `${mutation.kind}:${mutation.path}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      ...mutation,
      nodeEngineOverride: mutation.nodeEngineOverride ?? existing?.nodeEngineOverride,
    });
  }
  return [...byKey.values()];
}

function formatWorkspaceRootMutationWarning(mutation: WorkspaceRootMutation): string {
  const target = mutation.kind === "package-json" ? "package.json" : "configuration";
  const suffix =
    mutation.nodeEngineOverride === undefined
      ? ""
      : ` (${formatNodeEngineOverrideWarning(mutation.nodeEngineOverride)})`;
  return `Updated workspace root ${target} at ${mutation.path}${suffix}`;
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
): Promise<{ projectPath: string; workspaceRootMutations: WorkspaceRootMutation[] }> {
  const parentPath = resolve(parentDirectory);
  const createInPlace = projectName === CURRENT_DIRECTORY_PROJECT_NAME;
  const projectPath = createInPlace ? parentPath : join(parentPath, projectName);
  if (createInPlace) {
    await assertCanScaffoldInPlace(projectPath);
  } else if (await pathExists(projectPath)) {
    throw new Error(`Cannot create project because "${projectPath}" already exists.`);
  }

  const stagingDirectory = await mkdtemp(join(parentPath, ".eve-init-"));
  const workspaceRootMutations: WorkspaceRootMutation[] = [];
  try {
    const stagedProjectName = createInPlace ? basename(projectPath) : projectName;
    const scaffoldOptions = {
      projectName: stagedProjectName,
      model: DEFAULT_AGENT_MODEL_ID,
      evePackage,
      targetDirectory: stagingDirectory,
      workspaceProbeDirectory: projectPath,
      packageManager,
      onWorkspaceRootMutation: (mutation: WorkspaceRootMutation) => {
        workspaceRootMutations.push(mutation);
      },
    };
    const stagedProjectPath = await dependencies.scaffoldBaseProject(scaffoldOptions);

    if (options.channelWebNextjs === true) {
      await dependencies.ensureChannel({
        projectRoot: stagedProjectPath,
        kind: "web",
        packageManager,
        workspaceProbeDirectory: projectPath,
        configureVercelServices: false,
        onWorkspaceRootMutation: (mutation: WorkspaceRootMutation) => {
          workspaceRootMutations.push(mutation);
        },
      });
    }

    if (createInPlace) {
      await moveDirectoryContents(stagedProjectPath, projectPath);
    } else {
      await rename(stagedProjectPath, projectPath);
    }
    return {
      projectPath,
      workspaceRootMutations: uniqueWorkspaceRootMutations(workspaceRootMutations),
    };
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
      workspaceRootMutations: WorkspaceRootMutation[];
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
      workspaceRootMutations: WorkspaceRootMutation[];
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
      const scaffold = await scaffoldProject(
        parentDirectory,
        projectName,
        packageManager,
        options,
        dependencies,
        evePackage,
      );
      project = {
        kind: "created",
        packageManager,
        projectPath: scaffold.projectPath,
        workspaceRootMutations: scaffold.workspaceRootMutations,
      };
    } else {
      const addition = await addToExistingProject(
        existingDirectory,
        options,
        dependencies,
        evePackage,
      );
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
 * A coding agent that omits the target entirely gets the setup guide printed and
 * nothing scaffolded, since a bare `eve init` means it has not yet chosen what to
 * build.
 */
export async function runInitCommand(
  logger: InitCliLogger,
  parentDirectory: string,
  target: string | undefined,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies = defaultDependencies,
): Promise<void> {
  // A coding agent that runs `eve init` with no target has not decided what to
  // build yet. Hand it the setup guide (collect intent, then re-run with an
  // explicit target) rather than silently scaffolding the current directory. A
  // human, or an explicit `.`/`<name>`, still scaffolds.
  if (target === undefined && (await dependencies.isCodingAgentLaunch())) {
    logger.log(initAgentInstructions());
    return;
  }

  const result = await runInitSteps({ dependencies, logger, options, parentDirectory, target });

  if (result.kind === "created") {
    logger.log(
      `${pc.green("✓")} Created an ${EVE_WORDMARK} agent in ${pc.bold(result.projectPath)} ${pc.dim(`in ${formatElapsed(result.agentElapsedMs)}`)}`,
    );
    for (const mutation of result.workspaceRootMutations) {
      logger.log(pc.yellow(`⚠ ${formatWorkspaceRootMutationWarning(mutation)}`));
    }
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

  const agentDevCommand = [result.packageManager, ...eveDevArguments(result.packageManager)].join(
    " ",
  );
  const agentHandoff = initAgentDevHandoff({
    projectPath: result.projectPath,
    devCommand: agentDevCommand,
  });

  if (result.agentLaunched) {
    logger.log(agentHandoff);
    return;
  }

  let handoff: InitHandoff;
  try {
    handoff = await dependencies.selectInitHandoff({ agentName: basename(result.projectPath) });
  } catch (error) {
    if (error instanceof WizardCancelledError) return;
    throw error;
  }
  if (handoff !== "eve-dev") {
    logger.log(pc.dim(`$ ${handoff}`));
    if (
      !(await dependencies.spawnCodingAgentRepl({
        command: handoff,
        cwd: result.projectPath,
        prompt: initAgentReplPrompt({ devCommand: agentDevCommand }),
        // A `.cmd`/`.bat` shim can't take the multi-line prompt on its command
        // line, so print it for the user to paste once the REPL opens.
        onPromptUnseeded: (prompt) => {
          logger.log(
            pc.yellow(`Could not seed ${handoff} automatically. Paste this prompt into it:`),
          );
          logger.log(prompt);
        },
      }))
    ) {
      throw new Error(`Coding-agent REPL exited unsuccessfully in "${result.projectPath}".`);
    }
    return;
  }

  // Strictly the eve binary, never the project's dev script, which in an
  // existing app may start unrelated processes. Exec-style runs do not echo
  // the command the way run-scripts do, so the handoff line is printed here.
  const devArguments = eveDevArguments(result.packageManager);
  logger.log(pc.dim("$ eve dev"));
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
