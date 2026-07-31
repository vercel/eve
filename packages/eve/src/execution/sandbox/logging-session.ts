import type {
  SandboxRemovePathOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import { truncateTail } from "#execution/sandbox/truncate-output.js";

const MAX_LOG_VALUE_LENGTH = 240;
const PREPARATION_FAILURE_EXIT_CODE = 1;

export function createLoggingSandboxSession(input: {
  readonly log?: (message: string) => void;
  readonly session: SandboxSession;
}): SandboxSession {
  const { log, session } = input;

  return {
    ...session,
    async run(options: SandboxRunOptions) {
      log?.(`prepare run: ${formatCommand(options.command)}`);
      const result = await session.run(options);
      if (result.exitCode === PREPARATION_FAILURE_EXIT_CODE) {
        throw new Error(formatPreparationRunFailure(options.command, result));
      }
      return result;
    },
    async spawn(options: SandboxSpawnOptions) {
      log?.(`prepare spawn: ${formatCommand(options.command)}`);
      return await session.spawn(options);
    },
    async setNetworkPolicy(policy: SandboxNetworkPolicy) {
      log?.(`prepare set network policy: ${formatNetworkPolicy(policy)}`);
      return await session.setNetworkPolicy(policy);
    },
    async writeFile(options: SandboxWriteFileOptions) {
      log?.(`prepare write file: ${options.path}`);
      return await session.writeFile(options);
    },
    async writeBinaryFile(options: SandboxWriteBinaryFileOptions) {
      log?.(`prepare write binary file: ${options.path} (${options.content.byteLength} bytes)`);
      return await session.writeBinaryFile(options);
    },
    async writeTextFile(options: SandboxWriteTextFileOptions) {
      log?.(`prepare write text file: ${options.path} (${options.content.length} chars)`);
      return await session.writeTextFile(options);
    },
    async removePath(options: SandboxRemovePathOptions) {
      log?.(`prepare remove path: ${options.path}`);
      return await session.removePath(options);
    },
  };
}

function formatPreparationRunFailure(
  command: string,
  result: { readonly stderr: string; readonly stdout: string },
): string {
  return [
    `Sandbox preparation failed because sandbox.run command exited with code ${PREPARATION_FAILURE_EXIT_CODE}:`,
    command,
    "",
    "stdout:",
    formatCapturedOutput("stdout", result.stdout),
    "",
    "stderr:",
    formatCapturedOutput("stderr", result.stderr),
  ].join("\n");
}

function formatCapturedOutput(stream: "stderr" | "stdout", output: string): string {
  const truncated = truncateTail(output);
  if (!truncated.truncated) {
    return truncated.output;
  }
  return `[${stream} truncated: showing last ${truncated.outputLines} of ${truncated.totalLines} lines]\n${truncated.output}`;
}

function formatCommand(command: string): string {
  return truncateOneLine(command);
}

function formatNetworkPolicy(policy: SandboxNetworkPolicy): string {
  return truncateOneLine(typeof policy === "string" ? policy : JSON.stringify(policy));
}

function truncateOneLine(value: string): string {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_LOG_VALUE_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_LOG_VALUE_LENGTH - 1)}…`;
}
