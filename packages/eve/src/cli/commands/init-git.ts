import { execFile, type ExecFileOptions } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const GIT_TIMEOUT_MS = 5_000;
const runFile = promisify(execFile);

export type GitInitResult =
  | { kind: "initialized" }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

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

/**
 * Initializes a Git repository and records the generated files in an initial
 * commit. Missing Git and parent repositories are skips. A failed partial
 * initialization is removed and returned as a `failed` result; presenting the
 * failure (without failing `eve init`) is the caller's job.
 */
export async function tryInitializeGit(projectPath: string): Promise<GitInitResult> {
  if (!(await isGitAvailable()) || (await isInsideExistingRepository(projectPath))) {
    return { kind: "skipped" };
  }

  let initialized = false;
  try {
    await runGit(projectPath, ["init"]);
    initialized = true;

    if (!(await hasConfiguredDefaultBranch(projectPath))) {
      await runGit(projectPath, ["checkout", "-b", "main"]);
    }

    await runGit(projectPath, ["add", "-A"]);
    await runGit(projectPath, ["commit", "-m", "Initial commit from eve"]);
    return { kind: "initialized" };
  } catch (error) {
    if (initialized) {
      await rm(join(projectPath, ".git"), { recursive: true, force: true }).catch(() => {});
    }

    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason };
  }
}
