import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import pc from "picocolors";

import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import { EVE_WORDMARK } from "#cli/banner.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createLogger, isLogLevelEnabled } from "#internal/logging.js";
import { formatNodeEngineOverrideWarning } from "#setup/node-engine.js";
import {
  detectInvokingPackageManager,
  detectPackageManager,
  type PackageManagerKind,
} from "#setup/package-manager.js";
import { pathExists } from "#setup/path-exists.js";
import { parseProjectName } from "#setup/project-name.js";
import { runPackageManagerInstall } from "#setup/primitives/index.js";
import type { ProcessOutputLine } from "#setup/primitives/process-output.js";
import {
  DEFAULT_EVE_PACKAGE_CONTRACT,
  type EvePackageContract,
} from "#setup/scaffold/create/project.js";
import { scaffoldExtensionProject } from "#setup/scaffold/index.js";
import type { WorkspaceRootMutation } from "#setup/scaffold/workspace-root.js";

import { initExtensionHandoff, initExtensionInstructions } from "./agent-instructions.js";
import { tryInitializeGit, type GitInitResult } from "./init-git.js";

export interface ExtensionInitCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface ExtensionInitCommandDependencies {
  detectInvokingPackageManager: typeof detectInvokingPackageManager;
  detectPackageManager: typeof detectPackageManager;
  isCodingAgentLaunch: typeof isCodingAgentLaunch;
  now: () => number;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  scaffoldExtensionProject: typeof scaffoldExtensionProject;
  tryInitializeGit: typeof tryInitializeGit;
}

const defaultDependencies: ExtensionInitCommandDependencies = {
  detectInvokingPackageManager,
  detectPackageManager,
  isCodingAgentLaunch,
  now: () => performance.now(),
  runPackageManagerInstall,
  scaffoldExtensionProject,
  tryInitializeGit,
};

const CURRENT_DIRECTORY_PROJECT_NAME = ".";
const ALLOWED_CREATE_IN_PLACE_ENTRIES = new Set([".DS_Store", ".git", ".gitkeep", ".hg"]);
/** Same override env as agent `eve init` so CI can pin the eve package specifier. */
export const EVE_INIT_PACKAGE_SPEC_ENV = "EVE_INIT_PACKAGE_SPEC";

const initLog = createLogger("extension-init");

function isCurrentDirectoryTarget(target: string): boolean {
  return /^\.(?:[/\\]+\.?)*$/u.test(target.trim());
}

async function resolveTargetDirectory(
  parentDirectory: string,
  target: string,
): Promise<string | undefined> {
  const targetPath = resolve(parentDirectory, target);
  const stats = await stat(targetPath).catch(() => undefined);
  return stats?.isDirectory() ? targetPath : undefined;
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

async function resolveScaffoldPackageManager(
  projectPath: string,
  dependencies: ExtensionInitCommandDependencies,
): Promise<PackageManagerKind> {
  const detected = await dependencies.detectPackageManager(projectPath);
  if (detected.source !== "default") {
    return detected.kind;
  }
  return dependencies.detectInvokingPackageManager() ?? "pnpm";
}

async function scaffoldExtension(
  parentDirectory: string,
  projectName: string,
  packageManager: PackageManagerKind,
  dependencies: ExtensionInitCommandDependencies,
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

  const stagingDirectory = await mkdtemp(join(parentPath, ".eve-extension-init-"));
  const workspaceRootMutations: WorkspaceRootMutation[] = [];
  try {
    const stagedProjectName = createInPlace ? basename(projectPath) : projectName;
    const stagedProjectPath = await dependencies.scaffoldExtensionProject({
      projectName: stagedProjectName,
      evePackage,
      targetDirectory: stagingDirectory,
      workspaceProbeDirectory: projectPath,
      packageManager,
      onWorkspaceRootMutation: (mutation) => {
        workspaceRootMutations.push(mutation);
      },
    });

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

/**
 * Creates a new eve extension package. Same install/git flow as agent `eve init`,
 * but always create-only and prints next steps instead of starting `eve dev`.
 */
export async function runExtensionInitCommand(
  logger: ExtensionInitCliLogger,
  parentDirectory: string,
  target: string | undefined,
  dependencies: ExtensionInitCommandDependencies = defaultDependencies,
): Promise<void> {
  // Coding agent with no target: print a setup guide, same gate as agent init.
  if (target === undefined && (await dependencies.isCodingAgentLaunch())) {
    logger.log(initExtensionInstructions());
    return;
  }

  const debug = isLogLevelEnabled("debug");
  const progress = startCliLiveRow(logger);
  progress.update("Preparing project");

  let projectPath: string;
  let packageManager: PackageManagerKind;
  let workspaceRootMutations: WorkspaceRootMutation[] = [];
  let agentElapsedMs: number;
  let installElapsedMs: number;
  let gitResult: GitInitResult;

  try {
    const rawTarget = target ?? CURRENT_DIRECTORY_PROJECT_NAME;
    const currentDirectoryTarget = isCurrentDirectoryTarget(rawTarget);
    const existingDirectory = currentDirectoryTarget
      ? (await pathExists(join(resolve(parentDirectory), "package.json")))
        ? resolve(parentDirectory)
        : undefined
      : await resolveTargetDirectory(parentDirectory, rawTarget);
    const evePackage = resolveInitEvePackageOverride();

    if (existingDirectory !== undefined) {
      throw new Error(
        "`eve extension init` creates a new extension package and cannot add to an existing project. " +
          "Pass a new directory name, or run from an empty directory with `eve extension init .`.",
      );
    }

    progress.update("Creating extension");
    initLog.debug("creating extension");
    const agentStartedAt = dependencies.now();

    const projectName = currentDirectoryTarget
      ? CURRENT_DIRECTORY_PROJECT_NAME
      : parseProjectName(rawTarget);
    const parentPath = resolve(parentDirectory);
    const plannedProjectPath =
      projectName === CURRENT_DIRECTORY_PROJECT_NAME ? parentPath : join(parentPath, projectName);
    packageManager = await resolveScaffoldPackageManager(plannedProjectPath, dependencies);
    const scaffold = await scaffoldExtension(
      parentDirectory,
      projectName,
      packageManager,
      dependencies,
      evePackage,
    );
    projectPath = scaffold.projectPath;
    workspaceRootMutations = scaffold.workspaceRootMutations;
    agentElapsedMs = dependencies.now() - agentStartedAt;
    initLog.debug("creating extension done", { ms: agentElapsedMs });

    progress.update("Installing dependencies", `${packageManager} install`);
    initLog.debug(`installing dependencies with ${packageManager}`);
    const installStartedAt = dependencies.now();
    const installFailureOutput: string[] = [];
    const recentInstallOutput: string[] = [];
    const installed = await dependencies.runPackageManagerInstall(packageManager, projectPath, {
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
        const detail = installProgressDetail(packageManager, line);
        if (detail !== undefined) progress.update("Installing dependencies", detail);
      },
    });
    installElapsedMs = dependencies.now() - installStartedAt;
    if (!installed) {
      initLog.debug("dependency installation failed", { ms: installElapsedMs });
      progress.stop();
      const failureOutput =
        installFailureOutput.length > 0 ? installFailureOutput : recentInstallOutput;
      for (const line of failureOutput) logger.error(line);
      throw new Error(`Failed to install dependencies in "${projectPath}".`);
    }
    initLog.debug("dependencies installed", { ms: installElapsedMs });

    progress.update("Initializing Git repository");
    initLog.debug("initializing git repository");
    gitResult = await dependencies.tryInitializeGit(projectPath);
  } finally {
    progress.stop();
  }

  logger.log(
    `${pc.green("✓")} Created an ${EVE_WORDMARK} extension in ${pc.bold(projectPath!)} ${pc.dim(`in ${formatElapsed(agentElapsedMs!)}`)}`,
  );
  for (const mutation of workspaceRootMutations) {
    logger.log(pc.yellow(`⚠ ${formatWorkspaceRootMutationWarning(mutation)}`));
  }
  logger.log(
    `${pc.green("✓")} Installed dependencies ${pc.dim(`in ${formatElapsed(installElapsedMs!)}`)}`,
  );
  if (gitResult!.kind === "failed") {
    logger.error(pc.yellow(`Git initialization failed: ${gitResult!.reason}`));
  } else if (gitResult!.kind === "initialized") {
    logger.log(`${pc.green("✓")} Initialized Git repository`);
  }
  logger.log(
    initExtensionHandoff({
      packageManager: packageManager!,
      packageName: basename(projectPath!),
      projectPath: projectPath!,
    }),
  );
}
