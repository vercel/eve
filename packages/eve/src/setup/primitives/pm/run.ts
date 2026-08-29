import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import { armProcessAbort } from "../process-abort.js";
import { createProcessOutputBuffer, type ProcessOutputHandler } from "../process-output.js";
import { getPackageManagerStrategy } from "./index.js";
import {
  createPackageProcessStdoutCollector,
  type PackageManagerProcessResult,
  type PackageManagerProcessTermination,
  resultSucceeded,
} from "./process-result.js";
import {
  hasAncestorPnpmWorkspace,
  PNPM_WORKSPACE_MEMBERSHIP_ARGUMENTS,
  PNPM_WORKSPACE_PATH,
  pnpmWorkspaceClaimsProject,
} from "./pnpm.js";
import type { PackageManagerInstallOptions } from "./types.js";

/** Output routing options for setup-owned package manager commands. */
export interface RunPackageManagerOptions {
  /** Streams raw command output to a parent-owned local renderer. */
  onOutput?: ProcessOutputHandler;
  /** Aborts the package-manager subprocess when setup is interrupted. */
  signal?: AbortSignal;
  /** Retains bounded stdout for a caller that must interpret a command's output. */
  captureStdout?: boolean;
  /** Closes stdin so the child cannot contend with a parent-owned TUI. */
  nonInteractive?: boolean;
}

/** @deprecated Use {@link RunPackageManagerOptions}. */
export type RunPnpmOptions = RunPackageManagerOptions;

function abortedTermination(signal: AbortSignal | undefined): PackageManagerProcessTermination {
  const reason = signal?.reason;
  return reason === undefined
    ? { kind: "aborted" }
    : { kind: "aborted", reason: reason instanceof Error ? reason.message : String(reason) };
}

/** Runs one package-manager command and returns its complete process evidence. */
export function spawnPackageManager(
  kind: PackageManagerKind,
  projectRoot: string,
  args: readonly string[],
  options: RunPackageManagerOptions = {},
): Promise<PackageManagerProcessResult> {
  const strategy = getPackageManagerStrategy(kind);
  const managerArgs = strategy.prepareArguments(projectRoot, args);
  const invocation = strategy.resolveInvocation(managerArgs);
  const command = {
    executable: invocation.command,
    args: [...invocation.args],
    cwd: projectRoot,
  };
  if (options.signal?.aborted === true) {
    return Promise.resolve({
      command,
      termination: abortedTermination(options.signal),
      stdout: "",
    });
  }

  return new Promise((resolvePromise) => {
    const captureOutput = options.onOutput !== undefined || options.nonInteractive === true;
    const lineBuffer = options.onOutput && createProcessOutputBuffer(options.onOutput);
    const stdoutCollector =
      options.captureStdout === true ? createPackageProcessStdoutCollector({ command }) : undefined;
    let child;
    try {
      child = spawn(invocation.command, [...invocation.args], {
        cwd: projectRoot,
        stdio: captureOutput
          ? [options.nonInteractive ? "ignore" : "inherit", "pipe", "pipe"]
          : "inherit",
        shell: invocation.shell,
        signal: options.signal,
      });
    } catch (error) {
      lineBuffer?.flush();
      const failure = error as NodeJS.ErrnoException;
      resolvePromise({
        command,
        termination: { kind: "spawn-error", code: failure.code, message: failure.message },
        stdout: "",
      });
      return;
    }
    const disarmAbort = armProcessAbort(child, options.signal);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutCollector?.write(chunk);
      lineBuffer?.write("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => lineBuffer?.write("stderr", chunk));

    let settled = false;
    function settle(termination: PackageManagerProcessTermination): void {
      if (settled) return;
      settled = true;
      disarmAbort();
      stdoutCollector?.end();
      lineBuffer?.flush();
      resolvePromise(stdoutCollector?.result(termination) ?? { command, termination, stdout: "" });
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (options.signal?.aborted === true || error.name === "AbortError") {
        settle(abortedTermination(options.signal));
      } else {
        settle({ kind: "spawn-error", code: error.code, message: error.message });
      }
    });
    child.on("close", (code, signal) => {
      if (options.signal?.aborted === true) settle(abortedTermination(options.signal));
      else if (typeof signal === "string") settle({ kind: "signal", signal });
      else settle({ kind: "exit", code: code ?? 1 });
    });
  });
}

export interface RunInstallOptions extends RunPackageManagerOptions, PackageManagerInstallOptions {}

// A local workspace manifest makes standalone ownership unambiguous across pnpm
// versions; `--ignore-workspace` alone can still materialize against an ancestor.
function createStandalonePnpmWorkspace(projectRoot: string): () => void {
  const workspacePath = join(projectRoot, PNPM_WORKSPACE_PATH);
  try {
    writeFileSync(workspacePath, "packages: []\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return () => {};
    throw error;
  }
  return () => rmSync(workspacePath, { force: true });
}

async function runStandalonePnpmInstall(
  projectRoot: string,
  options: RunInstallOptions,
): Promise<PackageManagerProcessResult> {
  const cleanup = createStandalonePnpmWorkspace(projectRoot);
  try {
    return await spawnPackageManager(
      "pnpm",
      projectRoot,
      getPackageManagerStrategy("pnpm").installArguments(options),
      options,
    );
  } finally {
    cleanup();
  }
}

export type PackageManagerInstallResult =
  | { kind: "installed"; result: PackageManagerProcessResult }
  | { kind: "workspace-probe-failed"; result: PackageManagerProcessResult }
  | { kind: "workspace-probe-unrecognized"; result: PackageManagerProcessResult };

export function packageManagerInstallSucceeded(result: PackageManagerInstallResult): boolean {
  return result.kind === "installed" && resultSucceeded(result.result);
}

/** Returns an actionable explanation when a package-manager command produced no output. */
export function packageManagerInstallFailureMessage(
  result: PackageManagerInstallResult,
): string | undefined {
  if (result.result.termination.kind === "spawn-error") {
    return result.result.termination.code === "ENOENT"
      ? `${result.result.command.executable} was not found. Install it before running this step.`
      : `Could not start ${result.result.command.executable}: ${result.result.termination.message}`;
  }
  if (result.kind === "workspace-probe-unrecognized") {
    return "Could not determine whether the ancestor pnpm workspace includes this project.";
  }
  return undefined;
}

/** Installs project dependencies and keeps workspace-probe evidence distinct. */
export async function runPackageManagerInstall(
  kind: PackageManagerKind,
  projectRoot: string,
  options: RunInstallOptions = {},
): Promise<PackageManagerInstallResult> {
  const strategy = getPackageManagerStrategy(kind);
  if (kind === "pnpm" && options.ignoreWorkspace === true) {
    return {
      kind: "installed",
      result: await runStandalonePnpmInstall(projectRoot, options),
    };
  }
  if (kind === "pnpm" && hasAncestorPnpmWorkspace(projectRoot)) {
    const probe = await spawnPackageManager(
      kind,
      projectRoot,
      PNPM_WORKSPACE_MEMBERSHIP_ARGUMENTS,
      { ...options, captureStdout: true, nonInteractive: true },
    );
    if (!resultSucceeded(probe)) return { kind: "workspace-probe-failed", result: probe };
    const claimed = pnpmWorkspaceClaimsProject(probe.stdout, projectRoot);
    if (claimed === undefined) return { kind: "workspace-probe-unrecognized", result: probe };
    if (!claimed) {
      return {
        kind: "installed",
        result: await runStandalonePnpmInstall(projectRoot, options),
      };
    }
  }
  return {
    kind: "installed",
    result: await spawnPackageManager(
      kind,
      projectRoot,
      strategy.installArguments(options),
      options,
    ),
  };
}

/** The argv that runs the locally installed eve binary's `dev` command. */
export function eveDevArguments(kind: PackageManagerKind): readonly string[] {
  return getPackageManagerStrategy(kind).devArguments();
}

export function spawnPnpm(
  projectRoot: string,
  args: readonly string[],
  options: RunPackageManagerOptions = {},
): Promise<PackageManagerProcessResult> {
  return spawnPackageManager("pnpm", projectRoot, args, options);
}

export function runPnpmInstall(
  projectRoot: string,
  options: RunPackageManagerOptions = {},
): Promise<PackageManagerInstallResult> {
  return runPackageManagerInstall("pnpm", projectRoot, options);
}
