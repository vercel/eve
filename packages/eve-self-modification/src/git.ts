import { Buffer } from "node:buffer";

import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

const MAX_ERROR_OUTPUT = 2_000;
type CommandSandbox = Pick<SandboxSession, "run">;

export function buildBrokerNetworkPolicy(
  token: string,
  hosts: readonly string[],
  allowOtherEgress = false,
): SandboxNetworkPolicy {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const rule = [{ transform: [{ headers: { Authorization: authorization } }] }];
  const allow: Record<string, typeof rule> = Object.fromEntries(hosts.map((host) => [host, rule]));
  if (allowOtherEgress) allow["*"] = [];
  return { allow };
}

export async function withBrokeredGitEgress<T>(
  sandbox: Pick<SandboxSession, "setNetworkPolicy">,
  input: { readonly policy: SandboxNetworkPolicy; readonly restore: SandboxNetworkPolicy },
  operation: () => Promise<T>,
): Promise<T> {
  await sandbox.setNetworkPolicy(input.policy);
  let operationError: unknown;
  let value: T | undefined;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await sandbox.setNetworkPolicy(input.restore);
  } catch (revertError) {
    throw new Error(
      "Could not revoke brokered GitHub credentials; the sandbox is unsafe for model use.",
      {
        cause:
          operationError === undefined
            ? revertError
            : new AggregateError([operationError, revertError]),
      },
    );
  }
  if (operationError !== undefined) throw operationError;
  return value as T;
}

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

export function assertFullGitSha(value: string, label: string): void {
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${label} must be a lowercase full Git SHA.`);
}

export function assertRepositoryPart(value: string, label: string): void {
  if (
    !/^[A-Za-z0-9_.-]+$/u.test(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("-")
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

export function assertGitRef(value: string, label = "Git ref"): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.split("/").some((part) => part.endsWith(".lock"))
  )
    throw new Error(`${label} is not a valid Git ref.`);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(value: string): string {
  return value.length <= MAX_ERROR_OUTPUT ? value : `${value.slice(0, MAX_ERROR_OUTPUT)}…`;
}
