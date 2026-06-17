import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 5_000;

export type GitInitResult =
  | { kind: "initialized" }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

function isGitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "ignore", timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function isInsideExistingRepository(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    // Fall through to the Mercurial probe.
  }

  try {
    execSync("hg --cwd . root", { cwd, stdio: "ignore", timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredDefaultBranch(cwd: string): boolean {
  try {
    execSync("git config init.defaultBranch", {
      cwd,
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Initializes a Git repository and records the generated files in an initial
 * commit. Missing Git and parent repositories are skips. A failed partial
 * initialization is removed and returned as a `failed` result; presenting the
 * failure (without failing `eve init`) is the caller's job.
 */
export function tryInitializeGit(projectPath: string): GitInitResult {
  if (!isGitAvailable() || isInsideExistingRepository(projectPath)) {
    return { kind: "skipped" };
  }

  let initialized = false;
  try {
    execSync("git init", { cwd: projectPath, stdio: "ignore", timeout: GIT_TIMEOUT_MS });
    initialized = true;

    if (!hasConfiguredDefaultBranch(projectPath)) {
      execSync("git checkout -b main", {
        cwd: projectPath,
        stdio: "ignore",
        timeout: GIT_TIMEOUT_MS,
      });
    }

    execSync("git add -A", { cwd: projectPath, stdio: "ignore", timeout: GIT_TIMEOUT_MS });
    execSync('git commit -m "Initial commit from eve"', {
      cwd: projectPath,
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    return { kind: "initialized" };
  } catch (error) {
    if (initialized) {
      try {
        rmSync(join(projectPath, ".git"), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }

    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason };
  }
}
