import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";

const PROCESS_ROOT = "/workspace/.eve/processes";
const POLL_INTERVAL_MS = 250;
const PROCESS_LIMIT_MARKER = "EVE_BASH_PROCESS_LIMIT";

/**
 * Maximum number of tracked background bash processes per sandbox.
 * Launching past the cap first prunes completed process state; a
 * sandbox still at the cap after pruning rejects the new command.
 */
export const MAX_BACKGROUND_BASH_PROCESSES = 64;

export interface BackgroundBashProcess {
  readonly processId: string;
  read(): Promise<BackgroundBashProcessState>;
  kill(): Promise<void>;
}

export interface BackgroundBashProcessState {
  readonly exitCode?: number;
  readonly stderr: string;
  readonly stdout: string;
}

export async function startBackgroundBashProcess(
  sandbox: SandboxSession,
  command: string,
): Promise<BackgroundBashProcess> {
  const processId = randomUUID();
  const directory = `${PROCESS_ROOT}/${processId}`;
  const quotedRoot = shellQuote(PROCESS_ROOT);
  const launch = [
    `mkdir -p ${quotedRoot}`,
    // Reclaim completed process state before enforcing the process cap.
    `if [ "$(ls ${quotedRoot} | wc -l)" -ge ${MAX_BACKGROUND_BASH_PROCESSES} ]; then for d in ${quotedRoot}/*/; do [ -f "$d/exit-code" ] && rm -rf "$d"; done; fi`,
    `if [ "$(ls ${quotedRoot} | wc -l)" -ge ${MAX_BACKGROUND_BASH_PROCESSES} ]; then echo ${PROCESS_LIMIT_MARKER} >&2; exit 75; fi`,
    `mkdir -p ${shellQuote(directory)}`,
    `( eval ${shellQuote(command)}; code=$?; printf '%s' "$code" > ${shellQuote(`${directory}/exit-code`)} ) > ${shellQuote(`${directory}/stdout`)} 2> ${shellQuote(`${directory}/stderr`)} &`,
    `printf '%s' "$!" > ${shellQuote(`${directory}/pid`)}`,
  ].join("\n");
  const result = await sandbox.run({ command: launch });
  if (result.exitCode !== 0) {
    if (result.stderr.includes(PROCESS_LIMIT_MARKER)) {
      throw new Error(
        `This sandbox already tracks ${MAX_BACKGROUND_BASH_PROCESSES} running background commands. Kill or wait for existing processes before starting another.`,
      );
    }
    throw new Error(`Failed to start background command: ${result.stderr || result.stdout}`);
  }

  return backgroundBashProcess(sandbox, processId);
}

export function getBackgroundBashProcess(
  sandbox: SandboxSession,
  processId: string,
): BackgroundBashProcess {
  if (!/^[0-9a-f-]{36}$/.test(processId)) {
    throw new Error("Invalid bash process id.");
  }
  return backgroundBashProcess(sandbox, processId);
}

function backgroundBashProcess(sandbox: SandboxSession, processId: string): BackgroundBashProcess {
  const directory = `${PROCESS_ROOT}/${processId}`;
  return {
    processId,
    async read() {
      const [pid, exitCode, stdout, stderr] = await Promise.all([
        sandbox.readTextFile({ path: `${directory}/pid` }),
        sandbox.readTextFile({ path: `${directory}/exit-code` }),
        sandbox.readTextFile({ path: `${directory}/stdout` }),
        sandbox.readTextFile({ path: `${directory}/stderr` }),
      ]);
      if (pid === null) {
        throw new Error(`Bash process "${processId}" does not exist.`);
      }
      const state: { exitCode?: number; stderr: string; stdout: string } = {
        stderr: stderr ?? "",
        stdout: stdout ?? "",
      };
      if (exitCode !== null) {
        state.exitCode = Number.parseInt(exitCode, 10);
      }
      return state;
    },
    async kill() {
      const result = await sandbox.run({
        command: `pid=$(cat ${shellQuote(`${directory}/pid`)}) && [ "$pid" -gt 0 ] && { kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null; }`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Bash process "${processId}" could not be killed by this sandbox backend.`);
      }
    },
  };
}

export async function waitForBackgroundBashProcess(input: {
  readonly abortSignal?: AbortSignal;
  readonly process: BackgroundBashProcess;
  readonly yieldTimeMs: number;
}): Promise<BackgroundBashProcessState | null> {
  const deadline = Date.now() + input.yieldTimeMs;
  while (true) {
    input.abortSignal?.throwIfAborted();
    const state = await input.process.read();
    if (state.exitCode !== undefined) return state;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining));
      input.abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(input.abortSignal?.reason);
        },
        { once: true },
      );
    });
  }
}
