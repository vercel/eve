import { execFile, type ExecFileOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const GIT_TIMEOUT_MS = 5_000;
const runFile = promisify(execFile);

export type GitInitResult =
  | { kind: "initialized" }
  | { kind: "skipped"; reason: "existing-metadata" | "git-unavailable" | "parent-repository" }
  | {
      kind: "failed";
      repositoryInitialized: boolean;
      reason: string;
      stage: "initialize" | "default-branch" | "stage" | "commit";
    };

async function commandSucceeds(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<boolean> {
  try {
    const options: ExecFileOptions = { timeout: GIT_TIMEOUT_MS, windowsHide: true };
    if (cwd !== undefined) options.cwd = cwd;
    await runFile(command, [...args], options);
    return true;
  } catch {
    return false;
  }
}

function isGitAvailable(): Promise<boolean> {
  return commandSucceeds("git", ["--version"]);
}

async function isInsideExistingRepository(cwd: string): Promise<boolean> {
  return (
    (await commandSucceeds("git", ["rev-parse", "--is-inside-work-tree"], cwd)) ||
    (await commandSucceeds("hg", ["--cwd", ".", "root"], cwd))
  );
}

function hasConfiguredDefaultBranch(cwd: string): Promise<boolean> {
  return commandSucceeds("git", ["config", "init.defaultBranch"], cwd);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await runFile("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
}

async function runGitStage(
  cwd: string,
  stage: "initialize" | "default-branch" | "stage" | "commit",
  args: readonly string[],
  repositoryInitialized: boolean,
): Promise<GitInitResult | undefined> {
  try {
    await runGit(cwd, args);
    return undefined;
  } catch (error) {
    return {
      kind: "failed",
      repositoryInitialized,
      reason: error instanceof Error ? error.message : String(error),
      stage,
    };
  }
}

/**
 * Initializes a Git repository and records the generated files in an initial
 * commit. Missing Git and parent repositories are skips. Repository metadata
 * is retained when a later step fails so eve never destroys useful Git state.
 */
export async function tryInitializeGit(projectPath: string): Promise<GitInitResult> {
  const gitPath = join(projectPath, ".git");
  const gitMetadataExists = await stat(gitPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (gitMetadataExists) return { kind: "skipped", reason: "existing-metadata" };
  if (!(await isGitAvailable())) return { kind: "skipped", reason: "git-unavailable" };
  if (await isInsideExistingRepository(projectPath)) {
    return { kind: "skipped", reason: "parent-repository" };
  }

  const initFailure = await runGitStage(projectPath, "initialize", ["init"], false);
  if (initFailure !== undefined) return initFailure;

  if (!(await hasConfiguredDefaultBranch(projectPath))) {
    const branchFailure = await runGitStage(
      projectPath,
      "default-branch",
      ["checkout", "-b", "main"],
      true,
    );
    if (branchFailure !== undefined) return branchFailure;
  }

  const stageFailure = await runGitStage(projectPath, "stage", ["add", "-A"], true);
  if (stageFailure !== undefined) return stageFailure;

  const commitFailure = await runGitStage(
    projectPath,
    "commit",
    ["commit", "-m", "Initial commit from eve"],
    true,
  );
  return commitFailure ?? { kind: "initialized" };
}
