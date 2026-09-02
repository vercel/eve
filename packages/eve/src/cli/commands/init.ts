import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import pc from "#compiled/picocolors/index.js";

import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import { EVE_WORDMARK } from "#cli/banner.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createLogger, isLogLevelEnabled } from "#internal/logging.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { formatNodeEngineOverrideWarning, type NodeEngineOverride } from "#setup/node-engine.js";
import {
  detectInvokingPackageManager,
  detectPackageManager,
  type PackageManagerKind,
} from "#setup/package-manager.js";
import { pathExists } from "#setup/path-exists.js";
import {
  eveDevArguments,
  packageManagerInstallFailureMessage,
  packageManagerInstallSucceeded,
  resultSucceeded,
  runPackageManagerInstall,
  spawnPackageManager,
} from "#setup/primitives/index.js";
import type { ProcessOutputLine } from "#setup/primitives/process-output.js";
import { addAgentToProject } from "#setup/scaffold/create/add-to-project.js";
import { ensureChannel, scaffoldBaseProject } from "#setup/scaffold/index.js";
import { WizardCancelledError } from "#setup/step.js";
import { validateModelSlug } from "#setup/flows/model-source-change.js";
import {
  isPackageManagerWorkspaceMember,
  type WorkspaceRootMutation,
} from "#setup/scaffold/workspace-root.js";
import {
  DEFAULT_EVE_PACKAGE_CONTRACT,
  type EvePackageContract,
} from "#setup/scaffold/create/project.js";

import { initAgentDevHandoff, initAgentReplPrompt } from "./agent-instructions.js";
import { initAgentReadySummary } from "./agent-instructions.js";
import { confirmInitInNonEmptyDirectory } from "./init-confirm.js";
import {
  cleanupFreshInitTarget,
  workspaceFailureNote,
  type InitFailurePolicy,
} from "./init-recovery.js";
import { tryInitializeGit, type GitInitResult } from "./init-git.js";
import { selectInitHandoff, spawnCodingAgentRepl, type InitHandoff } from "./init-repl.js";
import { resolveInitTarget } from "./init-target.js";

export interface InitCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface InitCommandOptions {
  /** Add the Web Chat channel (a Next.js app). Set by `--channel-web-nextjs`. */
  channelWebNextjs?: boolean;
  /** Model id written to the root agent config. Set by `--model`. */
  model?: string;
  /** Reasoning effort written to the root agent config. Set by `--reasoning`. */
  reasoning?: AgentReasoningDefinition;
}

export interface InitCommandDependencies {
  addAgentToProject: typeof addAgentToProject;
  confirmInitInNonEmptyDirectory: typeof confirmInitInNonEmptyDirectory;
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
  validateModelSlug: typeof validateModelSlug;
}

const defaultDependencies: InitCommandDependencies = {
  addAgentToProject,
  confirmInitInNonEmptyDirectory,
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
  validateModelSlug,
};

const CURRENT_DIRECTORY_PROJECT_NAME = ".";
export const EVE_INIT_PACKAGE_SPEC_ENV = "EVE_INIT_PACKAGE_SPEC";

const initLog = createLogger("init");

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
): Promise<{
  configurationFilesChanged: string[];
  dependenciesAdded: string[];
  filesWritten: string[];
  packageManager: PackageManagerKind;
  nodeEngineOverride?: NodeEngineOverride;
}> {
  if (options.channelWebNextjs === true) {
    throw new Error(
      "`--channel-web-nextjs` is not supported when adding an agent to an existing project. " +
        "Run `eve add channel/web` from the project afterwards instead.",
    );
  }

  if (options.model !== undefined) {
    const rejection = await dependencies.validateModelSlug(targetPath, options.model);
    if (rejection !== null) throw new Error(rejection);
  }

  const manager = await dependencies.detectPackageManager(targetPath);
  const result = await dependencies.addAgentToProject({
    projectRoot: targetPath,
    model: options.model ?? DEFAULT_AGENT_MODEL_ID,
    reasoning: options.reasoning,
    packageManager: manager.kind,
    evePackage,
  });
  return {
    configurationFilesChanged: result.configurationFilesChanged,
    dependenciesAdded: result.dependenciesAdded,
    filesWritten: result.filesWritten,
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
  projectPath: string,
  projectName: string,
  createInPlace: boolean,
  packageManager: PackageManagerKind,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies,
  evePackage: EvePackageContract | undefined,
  overwriteExisting: boolean,
): Promise<{ projectPath: string; workspaceRootMutations: WorkspaceRootMutation[] }> {
  const parentPath = resolve(projectPath, "..");
  const populateExistingEmptyDirectory =
    !createInPlace && (await pathExists(projectPath)) && (await readdir(projectPath)).length === 0;
  if (!createInPlace && (await pathExists(projectPath)) && !populateExistingEmptyDirectory) {
    throw new Error(`Cannot create project because "${projectPath}" already exists.`);
  }

  const stagingDirectory =
    createInPlace && overwriteExisting ? undefined : await mkdtemp(join(parentPath, ".eve-init-"));
  const workspaceRootMutations: WorkspaceRootMutation[] = [];
  try {
    const scaffoldDirectory = stagingDirectory ?? projectPath;
    if (options.model !== undefined) {
      const rejection = await dependencies.validateModelSlug(scaffoldDirectory, options.model);
      if (rejection !== null) throw new Error(rejection);
    }
    const stagedProjectName =
      stagingDirectory === undefined
        ? CURRENT_DIRECTORY_PROJECT_NAME
        : createInPlace
          ? basename(projectPath)
          : projectName;
    const scaffoldOptions = {
      projectName: stagedProjectName,
      model: options.model ?? DEFAULT_AGENT_MODEL_ID,
      reasoning: options.reasoning,
      evePackage,
      targetDirectory: scaffoldDirectory,
      overwriteExisting,
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
        force: overwriteExisting,
        workspaceProbeDirectory: projectPath,
        configureVercelServices: false,
        onWorkspaceRootMutation: (mutation: WorkspaceRootMutation) => {
          workspaceRootMutations.push(mutation);
        },
      });
    }

    if (stagingDirectory !== undefined) {
      if (createInPlace || populateExistingEmptyDirectory) {
        await moveDirectoryContents(stagedProjectPath, projectPath);
      } else {
        await rename(stagedProjectPath, projectPath);
      }
    }
    return {
      projectPath,
      workspaceRootMutations: uniqueWorkspaceRootMutations(workspaceRootMutations),
    };
  } finally {
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

type PreparedInitProject =
  | {
      configurationFilesChanged: string[];
      dependenciesAdded: string[];
      failurePolicy: "preserve";
      filesWritten: string[];
      kind: "added";
      nodeEngineOverride?: NodeEngineOverride;
      packageManager: PackageManagerKind;
      projectPath: string;
    }
  | {
      failurePolicy: InitFailurePolicy;
      kind: "created";
      packageManager: PackageManagerKind;
      preservedTargetEntries: readonly string[];
      projectPath: string;
      retryCommand: string;
      workspaceMember: boolean;
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
      configurationFilesChanged: string[];
      dependenciesAdded: string[];
      filesWritten: string[];
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

function reportExistingProjectChanges(
  logger: InitCliLogger,
  project: Extract<PreparedInitProject, { kind: "added" }>,
): void {
  logger.log("Updated existing project:");
  for (const path of project.filesWritten) {
    logger.log(`  Created ${relative(project.projectPath, path).replaceAll("\\", "/")}`);
  }
  if (project.dependenciesAdded.length > 0) {
    logger.log(`  Added dependencies: ${project.dependenciesAdded.join(", ")}`);
  }
  for (const path of project.configurationFilesChanged) {
    logger.log(`  Updated ${path}`);
  }
  if (project.nodeEngineOverride !== undefined) {
    logger.log(pc.yellow(`  ⚠ ${formatNodeEngineOverrideWarning(project.nodeEngineOverride)}`));
  }
}

async function runInitSteps(input: {
  dependencies: InitCommandDependencies;
  logger: InitCliLogger;
  options: InitCommandOptions;
  parentDirectory: string;
  target: string | undefined;
}): Promise<InitResult> {
  const { dependencies, logger, options, parentDirectory, target } = input;
  const debug = isLogLevelEnabled("debug");
  const agentLaunched = await dependencies.isCodingAgentLaunch();
  const initTarget = await resolveInitTarget({ parentDirectory, target });
  const evePackage = resolveInitEvePackageOverride();

  let progress = startCliLiveRow(logger);
  progress.update("Preparing project");
  try {
    const scaffoldPhase = initTarget.kind === "fresh" ? "creating agent" : "adding agent";
    progress.update(initTarget.kind === "fresh" ? "Creating agent" : "Adding agent");
    initLog.debug(scaffoldPhase);
    const agentStartedAt = dependencies.now();
    let project: PreparedInitProject;
    if (initTarget.kind === "fresh") {
      const packageManager = await resolveScaffoldPackageManager(
        initTarget.projectPath,
        dependencies,
      );
      const workspaceMember = isPackageManagerWorkspaceMember(
        packageManager,
        initTarget.projectPath,
      );
      let scaffold: Awaited<ReturnType<typeof scaffoldProject>>;
      try {
        scaffold = await scaffoldProject(
          initTarget.projectPath,
          initTarget.projectName,
          initTarget.createInPlace,
          packageManager,
          options,
          dependencies,
          evePackage,
          initTarget.overwriteExisting,
        );
      } catch (error) {
        if (initTarget.failurePolicy === "clear") {
          const cleaned = await cleanupFreshInitTarget(
            initTarget.projectPath,
            initTarget.failurePolicy,
            initTarget.preservedEntries,
          );
          const detail = error instanceof Error ? error.message : String(error);
          const cleanup = cleaned
            ? `eve restored "${initTarget.projectPath}" to its original state.`
            : `eve could not completely clean "${initTarget.projectPath}".`;
          throw new Error(`${detail}\n\n${cleanup}${workspaceFailureNote(workspaceMember)}`);
        }
        if (initTarget.failurePolicy === "remove" && workspaceMember) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`${detail}${workspaceFailureNote(true)}`);
        }
        throw error;
      }
      project = {
        failurePolicy: initTarget.failurePolicy,
        kind: "created",
        packageManager,
        preservedTargetEntries: initTarget.preservedEntries,
        projectPath: scaffold.projectPath,
        retryCommand: `eve init ${initTarget.projectPath}`,
        workspaceMember,
        workspaceRootMutations: scaffold.workspaceRootMutations,
      };
    } else {
      const addition = await addToExistingProject(
        initTarget.projectPath,
        options,
        dependencies,
        evePackage,
      );
      project =
        addition.nodeEngineOverride === undefined
          ? {
              configurationFilesChanged: addition.configurationFilesChanged,
              dependenciesAdded: addition.dependenciesAdded,
              failurePolicy: "preserve",
              filesWritten: addition.filesWritten,
              kind: "added",
              packageManager: addition.packageManager,
              projectPath: initTarget.projectPath,
            }
          : {
              configurationFilesChanged: addition.configurationFilesChanged,
              dependenciesAdded: addition.dependenciesAdded,
              failurePolicy: "preserve",
              filesWritten: addition.filesWritten,
              kind: "added",
              nodeEngineOverride: addition.nodeEngineOverride,
              packageManager: addition.packageManager,
              projectPath: initTarget.projectPath,
            };
    }
    const agentElapsedMs = dependencies.now() - agentStartedAt;
    initLog.debug(`${scaffoldPhase} done`, { ms: agentElapsedMs });
    if (project.kind === "added") {
      progress.stop();
      reportExistingProjectChanges(logger, project);
      progress = startCliLiveRow(logger);
    }

    progress.update("Installing dependencies", `${project.packageManager} install`);
    initLog.debug(`installing dependencies with ${project.packageManager}`);
    const installStartedAt = dependencies.now();
    const installFailureOutput: string[] = [];
    const recentInstallOutput: string[] = [];
    const installResult = await dependencies.runPackageManagerInstall(
      project.packageManager,
      project.projectPath,
      {
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
    if (!packageManagerInstallSucceeded(installResult)) {
      initLog.debug("dependency installation failed", { ms: installElapsedMs });
      progress.stop();
      const failureOutput =
        installFailureOutput.length > 0 ? installFailureOutput : recentInstallOutput;
      for (const line of failureOutput) logger.error(line);
      if (failureOutput.length === 0) {
        const message = packageManagerInstallFailureMessage(installResult);
        if (message !== undefined) logger.error(message);
      }

      if (project.failurePolicy !== "preserve") {
        const cleaned = await cleanupFreshInitTarget(
          project.projectPath,
          project.failurePolicy,
          project.preservedTargetEntries,
        );
        if (cleaned) {
          const cleanup =
            project.failurePolicy === "remove"
              ? `eve removed the incomplete project at "${project.projectPath}".`
              : `eve restored "${project.projectPath}" to its original state.`;
          const workspaceChanged =
            project.workspaceMember || project.workspaceRootMutations.length > 0;
          throw new Error(
            `Failed to install dependencies.\n\n${cleanup}\n\nResolve the package-manager error above, then retry:\n  ${project.retryCommand}${workspaceFailureNote(workspaceChanged)}`,
          );
        }

        const workspaceChanged =
          project.workspaceMember || project.workspaceRootMutations.length > 0;
        throw new Error(
          `Failed to install dependencies, and eve could not completely clean "${project.projectPath}".\n\nResolve the package-manager error above, then install dependencies with ${project.packageManager} in that directory. Or clean the target manually before rerunning eve init.${workspaceFailureNote(workspaceChanged)}`,
        );
      }

      throw new Error(
        `The eve agent was added, but dependency installation failed.\n\nResolve the package-manager error above, then install dependencies with ${project.packageManager} in "${project.projectPath}".\n\nDo not rerun eve init; the agent is already configured.`,
      );
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
 * existing project (`target` is a directory), without external provisioning.
 * A fresh in-place scaffold asks whether to use the current directory or a new
 * subdirectory when the current directory is not empty. Coding-agent launches
 * must pass an explicit subdirectory instead.
 *
 * Runs launched by a coding agent get the dev command printed instead of
 * spawned after scaffolding, since the dev TUI would wedge the launching agent.
 *
 * For extension packages, use `eve extension init` instead.
 */
export async function runInitCommand(
  logger: InitCliLogger,
  parentDirectory: string,
  target: string | undefined,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies = defaultDependencies,
): Promise<void> {
  let result: InitResult;
  try {
    result = await runInitSteps({ dependencies, logger, options, parentDirectory, target });
  } catch (error) {
    if (error instanceof WizardCancelledError) return;
    throw error;
  }

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
  }
  logger.log(
    `${pc.green("✓")} Installed dependencies ${pc.dim(`in ${formatElapsed(result.installElapsedMs)}`)}`,
  );

  if (result.kind === "created" && result.gitResult.kind === "failed") {
    logger.error(
      pc.yellow(
        `Git initialization failed during ${result.gitResult.stage}: ${result.gitResult.reason}`,
      ),
    );
    if (result.gitResult.stage === "commit") {
      logger.error(
        pc.yellow(
          `The eve agent was created successfully. Git repository metadata and staged files were preserved at "${result.projectPath}"; the initial commit is optional.\n\nTo create it later, configure Git identity and run:\n  git -C ${JSON.stringify(result.projectPath)} commit -m "Initial commit from eve"`,
        ),
      );
    }
  }

  const baseDevArguments = [...eveDevArguments(result.packageManager)];
  const agentDevCommand = [result.packageManager, ...baseDevArguments].join(" ");
  const agentHandoff = initAgentDevHandoff({
    projectPath: result.projectPath,
    devCommand: agentDevCommand,
  });

  if (result.agentLaunched) {
    logger.log(initAgentReadySummary(options.model, result.projectPath));
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
  if (handoff === "exit") return;
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
  const freshScaffold = result.kind === "created";
  const devArguments = freshScaffold ? [...baseDevArguments, "--onboard"] : baseDevArguments;
  logger.log(pc.dim("$ eve dev"));
  if (
    !resultSucceeded(
      await dependencies.spawnPackageManager(
        result.packageManager,
        result.projectPath,
        devArguments,
      ),
    )
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
