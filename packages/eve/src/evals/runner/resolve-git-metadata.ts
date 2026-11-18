import { execSync } from "node:child_process";

interface GitMetadata {
  readonly branch?: string;
  readonly sha?: string;
}

export function resolveLocalGitMetadata(cwd: string): GitMetadata {
  const sha = execGitCommand("git rev-parse HEAD", cwd);
  const branch = execGitCommand("git branch --show-current", cwd);

  return {
    branch: branch || undefined,
    sha: sha || undefined,
  };
}

function execGitCommand(command: string, cwd: string): string | undefined {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined;
  }
}
