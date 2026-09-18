import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import pc from "#compiled/picocolors/index.js";

import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import type {
  EveCliSetupFailureCode,
  EveCliSetupStep,
  EveCliSetupTerminalResult,
} from "#cli/telemetry/index.js";
import { eveCliBanner, EVE_WORDMARK } from "#cli/banner.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createLogger, isLogLevelEnabled } from "#internal/logging.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import type { NodeEngineOverride } from "#setup/node-engine.js";
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

import { initAgentDevHandoff } from "./agent-instructions.js";
import { createInstallDiagnostics, packageManagerInstallFailureCode } from "./init-install.js";
import {
  addAgentsToWorkspace,
  convertScaffoldToAgentWorkspace,
  formatWorkspaceRootMutationWarning,
  type InitCliLogger,
  type InitCommandOptions,
} from "./init-agent-workspace.js";
import { initAgentReadySummary } from "./agent-instructions.js";
import { tryInitializeGit } from "./init-git.js";
import { InitTargetError } from "./init-telemetry.js";
import {
  reportExistingProjectChanges,
  type InitResult,
  type PreparedInitProject,
} from "./init-project.js";
import { cleanupFreshInitTarget, workspaceFailureNote } from "./init-recovery.js";
import { hasInteractiveTerminal } from "./preconditions.js";
import { resolveInitTarget } from "./init-target.js";

export type { InitCliLogger, InitCommandOptions } from "./init-agent-workspace.js";

export interface InitCommandDependencies {
  addAgentToProject: typeof addAgentToProject;
  detectInvokingPackageManager: typeof detectInvokingPackageManager;
  detectPackageManager: typeof detectPackageManager;
  ensureChannel: typeof ensureChannel;
  isCodingAgentLaunch: typeof isCodingAgentLaunch;
  now: () => number;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  scaffoldBaseProject: typeof scaffoldBaseProject;
  hasInteractiveTerminal: typeof hasInteractiveTerminal;
  spawnPackageManager: typeof spawnPackageManager;
  tryInitializeGit: typeof tryInitializeGit;
  validateModelSlug: typeof validateModelSlug;
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
  hasInteractiveTerminal,
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
    if (options.agents !== undefined) {
      await convertScaffoldToAgentWorkspace(stagedProjectPath, options.agents, options);
    }

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

type InitTerminalTracker = (
  step: EveCliSetupStep,
  result: EveCliSetupTerminalResult,
  failureCode?: EveCliSetupFailureCode,
) => void;

async function runInitSteps(input: {
  dependencies: InitCommandDependencies;
  logger: InitCliLogger;
  options: InitCommandOptions;
  parentDirectory: string;
  target: string | undefined;
  agentLaunched: boolean;
  interactive: boolean;
  trackStep?: (step: EveCliSetupStep) => void;
  trackTerminal?: InitTerminalTracker;
}): Promise<InitResult> {
  const {
    agentLaunched,
    dependencies,
    interactive,
    logger,
    options,
    parentDirectory,
    target,
    trackStep,
    trackTerminal,
  } = input;
  const debug = isLogLevelEnabled("debug");
  const initTarget = await resolveInitTarget({ parentDirectory, target });
  const evePackage = resolveInitEvePackageOverride();
  const selfModificationEnabled = false;

  const startedAt = dependencies.now();
  const progressOptions = {
    animate: interactive && !agentLaunched && !process.env.CI && process.env.TERM !== "dumb",
    elapsed: true,
    logPhases: true,
  };
  let progress = startCliLiveRow(logger, progressOptions);
  let activeInitStep: EveCliSetupStep = "scaffold";
  let installFailureCode: EveCliSetupFailureCode | undefined;
  try {
    const scaffoldPhase = initTarget.kind === "fresh" ? "creating agent" : "adding agent";
    trackStep?.(activeInitStep);
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
      progress = startCliLiveRow(logger, progressOptions);
    }

    activeInitStep = "install_dependencies";
    trackStep?.(activeInitStep);
    progress.update("Installing dependencies", project.packageManager);
    initLog.debug(`installing dependencies with ${project.packageManager}`);
    const installStartedAt = dependencies.now();
    const diagnostics = createInstallDiagnostics();
    const installResult = await dependencies.runPackageManagerInstall(
      project.packageManager,
      project.projectPath,
      {
        autoApprove: true,
        bypassMinimumReleaseAge: true,
        progressDetails: false,
        onOutput: (line) => {
          diagnostics.append(line.text);
          if (debug) initLog.debug(line.text);
        },
      },
    );
    const installElapsedMs = dependencies.now() - installStartedAt;
    if (!packageManagerInstallSucceeded(installResult)) {
      installFailureCode = packageManagerInstallFailureCode(installResult);
      initLog.debug("dependency installation failed", { ms: installElapsedMs });
      progress.stop();
      const { lines: failureOutput, truncated } = diagnostics.result();
      if (truncated) logger.error("Earlier install output omitted; showing the final diagnostics.");
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
      activeInitStep = "initialize_git";
      trackStep?.(activeInitStep);
      progress.update("Initializing Git");
      initLog.debug("initializing git repository");
      const gitResult = await dependencies.tryInitializeGit(project.projectPath);
      return {
        ...project,
        elapsedMs: dependencies.now() - startedAt,
        agentLaunched,
        gitResult,
        selfModificationEnabled,
      };
    }

    return {
      ...project,
      elapsedMs: dependencies.now() - startedAt,
      agentLaunched,
      selfModificationEnabled,
    };
  } catch (error) {
    trackTerminal?.(
      activeInitStep,
      "error",
      activeInitStep === "install_dependencies" ? installFailureCode : undefined,
    );
    throw error;
  } finally {
    progress.stop();
  }
}

export async function runInitCommand(
  logger: InitCliLogger,
  parentDirectory: string,
  target: string | undefined,
  options: InitCommandOptions,
  dependencies: InitCommandDependencies = defaultDependencies,
  trackStep?: (step: EveCliSetupStep) => void,
  trackTerminal?: InitTerminalTracker,
): Promise<void> {
  const agentLaunched = await dependencies.isCodingAgentLaunch();
  const interactive = dependencies.hasInteractiveTerminal();
  logger.log(eveCliBanner());

  trackStep?.("resolve_target");
  let result: InitResult;
  try {
    if (
      await addAgentsToWorkspace(
        logger,
        parentDirectory,
        target,
        options,
        dependencies.validateModelSlug,
      )
    ) {
      trackStep?.("handoff");
      trackTerminal?.("handoff", "completed");
      return;
    }

    result = await runInitSteps({
      agentLaunched,
      interactive,
      dependencies,
      logger,
      options,
      parentDirectory,
      target,
      trackStep,
      trackTerminal,
    });
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      trackTerminal?.("resolve_target", "cancelled");
      return;
    }
    if (error instanceof InitTargetError) {
      trackTerminal?.("resolve_target", "error", error.failureCode);
    }
    throw error;
  }

  trackStep?.("handoff");
  if (result.kind === "created") {
    logger.log(
      `${pc.green("✓")} Created an ${EVE_WORDMARK} agent in ${pc.bold(result.projectPath)} ${pc.dim(`in ${formatElapsed(result.elapsedMs)}`)}`,
    );
    for (const mutation of result.workspaceRootMutations) {
      logger.log(pc.yellow(`⚠ ${formatWorkspaceRootMutationWarning(mutation)}`));
    }
  } else {
    logger.log(
      `${pc.green("✓")} Added an ${EVE_WORDMARK} agent to ${pc.bold(result.projectPath)} ${pc.dim(`in ${formatElapsed(result.elapsedMs)}`)}`,
    );
  }
  if (result.selfModificationEnabled) {
    logger.log(`${pc.green("✓")} Enabled self-modification`);
  }

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

  const baseDevArguments = eveDevArguments(result.packageManager);
  const agentDevCommand = [result.packageManager, ...baseDevArguments].join(" ");
  const agentHandoff = initAgentDevHandoff({
    projectPath: result.projectPath,
    devCommand: agentDevCommand,
  });

  if (result.agentLaunched) {
    logger.log(
      initAgentReadySummary(options.model, result.projectPath, {
        workspace: options.agents !== undefined,
      }),
    );
    logger.log(agentHandoff);
    return;
  }

  if (!interactive) {
    logger.log(agentHandoff);
    return;
  }

  // Strictly the eve binary, never the project's dev script, which in an
  // existing app may start unrelated processes.
  const freshScaffold = result.kind === "created";
  const devArguments = freshScaffold ? [...baseDevArguments, "--onboard"] : baseDevArguments;
  logger.log("");
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
