import type { SandboxSession } from "eve/sandbox";

const MAX_ERROR_OUTPUT = 2_000;
type CommandSandbox = Pick<SandboxSession, "run">;

export async function gitOutput(
  sandbox: CommandSandbox,
  command: string,
  trim = true,
): Promise<string> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) throw gitCommandError(command, result);
  const stdout = String(result.stdout ?? "");
  return trim ? stdout.trim() : stdout;
}

export async function runGitCommand(sandbox: CommandSandbox, command: string): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) throw gitCommandError(command, result);
}

function gitCommandError(
  command: string,
  result: { readonly exitCode: number; readonly stderr?: unknown; readonly stdout?: unknown },
): Error {
  const stderr = truncate(String(result.stderr ?? "").trim());
  const stdout = truncate(String(result.stdout ?? "").trim());
  return new Error(
    [
      `Git command failed with exit ${result.exitCode}: ${command}`,
      stderr && `stderr: ${stderr}`,
      stdout && `stdout: ${stdout}`,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

function truncate(value: string): string {
  return value.length <= MAX_ERROR_OUTPUT ? value : `${value.slice(0, MAX_ERROR_OUTPUT)}…`;
}
