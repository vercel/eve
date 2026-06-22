import { spawn } from "node:child_process";

import type { PackageManagerKind } from "../../package-manager.js";
import { armProcessAbort } from "../process-abort.js";
import { createProcessOutputBuffer, type ProcessOutputHandler } from "../process-output.js";
import { getPackageManagerStrategy } from "./index.js";
import {
  hasAncestorPnpmWorkspace,
  PNPM_WORKSPACE_MEMBERSHIP_ARGUMENTS,
  pnpmWorkspaceClaimsProject,
} from "./pnpm.js";
import type { PackageManagerInstallOptions } from "./types.js";

/** Output routing options for setup-owned package manager commands. */
export interface RunPackageManagerOptions {
  /** Streams command output to a parent-owned renderer instead of writing outside it. */
  onOutput?: ProcessOutputHandler;
  /** Aborts the package-manager subprocess when setup is interrupted. */
  signal?: AbortSignal;
  /**
   * Closes stdin so the child cannot prompt — required when a repainting TUI
   * owns the terminal in raw mode, where an inherited stdin would let the child
   * contend for keystrokes.
   */
  nonInteractive?: boolean;
}

/**
 * stdin is closed under {@link RunPackageManagerOptions.nonInteractive}; stdout
 * and stderr pipe to `onOutput` when present, else inherit the terminal. The
 * fully-inherited default keeps its `"inherit"` shorthand so it stays identical
 * to the prior behavior.
 */
function stdioForRun(
  options: RunPackageManagerOptions,
): "inherit" | ["ignore" | "inherit", "pipe" | "inherit", "pipe" | "inherit"] {
  if (options.onOutput) {
    return [options.nonInteractive ? "ignore" : "inherit", "pipe", "pipe"];
  }
  return options.nonInteractive ? ["ignore", "inherit", "inherit"] : "inherit";
}

/** @deprecated Use {@link RunPackageManagerOptions}. */
export type RunPnpmOptions = RunPackageManagerOptions;

/** Runs the selected package manager in `projectRoot`. */
export function spawnPackageManager(
  kind: PackageManagerKind,
  projectRoot: string,
  args: readonly string[],
  options: RunPackageManagerOptions = {},
): Promise<boolean> {
  if (options.signal?.aborted === true) return Promise.resolve(false);
  return new Promise<boolean>((resolvePromise) => {
    const strategy = getPackageManagerStrategy(kind);
    const managerArgs = strategy.prepareArguments(projectRoot, args);
    const invocation = strategy.resolveInvocation(managerArgs);
    const outputBuffer = options.onOutput && createProcessOutputBuffer(options.onOutput);
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: projectRoot,
      stdio: stdioForRun(options),
      shell: invocation.shell,
      signal: options.signal,
    });
    const disarmAbort = armProcessAbort(child, options.signal);
    child.stdout?.on("data", (chunk: Buffer) => outputBuffer?.write("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => outputBuffer?.write("stderr", chunk));

    let settled = false;
    function settle(ok: boolean): void {
      if (settled) return;
      settled = true;
      outputBuffer?.flush();
      resolvePromise(ok);
    }
    function reportFailure(message: string): void {
      if (options.onOutput) {
        options.onOutput({ stream: "stderr", text: message });
      } else {
        process.stderr.write(`\n${message}\n`);
      }
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (options.signal?.aborted === true || error.name === "AbortError") {
        return;
      } else if (error.code === "ENOENT") {
        disarmAbort();
        reportFailure(`${kind} not found. Install it before running this step.`);
        settle(false);
      } else {
        disarmAbort();
        reportFailure(`${kind} ${args.join(" ")} failed: ${error.message}`);
        settle(false);
      }
    });
    child.on("close", (code) => {
      disarmAbort();
      settle(options.signal?.aborted === true ? false : code === 0);
    });
  });
}

export interface RunInstallOptions extends RunPackageManagerOptions, PackageManagerInstallOptions {}

interface PackageManagerCaptureResult {
  ok: boolean;
  stdout: string;
}

function capturePackageManager(
  kind: PackageManagerKind,
  projectRoot: string,
  args: readonly string[],
  options: RunPackageManagerOptions,
): Promise<PackageManagerCaptureResult> {
  if (options.signal?.aborted === true) {
    return Promise.resolve({ ok: false, stdout: "" });
  }
  return new Promise<PackageManagerCaptureResult>((resolvePromise) => {
    const strategy = getPackageManagerStrategy(kind);
    const managerArgs = strategy.prepareArguments(projectRoot, args);
    const invocation = strategy.resolveInvocation(managerArgs);
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: invocation.shell,
      signal: options.signal,
    });
    const disarmAbort = armProcessAbort(child, options.signal);
    const stdout: Buffer[] = [];
    const outputBuffer = options.onOutput && createProcessOutputBuffer(options.onOutput);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => outputBuffer?.write("stderr", chunk));

    let settled = false;
    function settle(ok: boolean): void {
      if (settled) return;
      settled = true;
      outputBuffer?.flush();
      resolvePromise({ ok, stdout: Buffer.concat(stdout).toString("utf8") });
    }
    function reportFailure(message: string): void {
      if (options.onOutput) {
        options.onOutput({ stream: "stderr", text: message });
      } else {
        process.stderr.write(`\n${message}\n`);
      }
    }
    function replayCapturedStdout(): void {
      const captured = Buffer.concat(stdout);
      if (captured.length === 0) return;
      if (outputBuffer) {
        outputBuffer.write("stdout", captured);
        outputBuffer.flush();
      } else {
        process.stdout.write(captured);
      }
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (options.signal?.aborted === true || error.name === "AbortError") {
        return;
      } else {
        disarmAbort();
        replayCapturedStdout();
        reportFailure(
          error.code === "ENOENT"
            ? `${kind} not found. Install it before running this step.`
            : `${kind} ${args.join(" ")} failed: ${error.message}`,
        );
        settle(false);
      }
    });
    child.on("close", (code) => {
      disarmAbort();
      if (!settled && code !== 0 && options.signal?.aborted !== true) {
        replayCapturedStdout();
        reportFailure(`${kind} ${args.join(" ")} exited with code ${code ?? "unknown"}.`);
      }
      settle(options.signal?.aborted === true ? false : code === 0);
    });
  });
}

/**
 * Installs project dependencies using the selected package-manager strategy.
 *
 * pnpm resolves an unclaimed nested project as part of an ancestor workspace,
 * where `install` can exit successfully without touching the project and can
 * run the ancestor's lifecycle scripts. Membership is therefore established
 * before installation, so exactly one correctly scoped install runs.
 */
export async function runPackageManagerInstall(
  kind: PackageManagerKind,
  projectRoot: string,
  options: RunInstallOptions = {},
): Promise<boolean> {
  const strategy = getPackageManagerStrategy(kind);
  let installOptions = options;
  if (
    kind === "pnpm" &&
    options.ignoreWorkspace !== true &&
    hasAncestorPnpmWorkspace(projectRoot)
  ) {
    const membership = await capturePackageManager(
      kind,
      projectRoot,
      PNPM_WORKSPACE_MEMBERSHIP_ARGUMENTS,
      options,
    );
    if (!membership.ok) return false;
    const claimed = pnpmWorkspaceClaimsProject(membership.stdout, projectRoot);
    if (claimed === undefined) {
      options.onOutput?.({
        stream: "stderr",
        text: "Could not determine whether the ancestor pnpm workspace includes this project.",
      });
      return false;
    }
    if (!claimed) {
      installOptions = { ...options, ignoreWorkspace: true };
    }
  }
  return spawnPackageManager(kind, projectRoot, strategy.installArguments(installOptions), options);
}

/** The argv that runs the locally installed eve binary's `dev` command. */
export function eveDevArguments(kind: PackageManagerKind): readonly string[] {
  return getPackageManagerStrategy(kind).devArguments();
}

/** Compatibility wrapper for callers that still explicitly require pnpm. */
export function spawnPnpm(
  projectRoot: string,
  args: readonly string[],
  options: RunPackageManagerOptions = {},
): Promise<boolean> {
  return spawnPackageManager("pnpm", projectRoot, args, options);
}

/** Compatibility wrapper for callers that still explicitly require pnpm. */
export function runPnpmInstall(
  projectRoot: string,
  options: RunPackageManagerOptions = {},
): Promise<boolean> {
  return runPackageManagerInstall("pnpm", projectRoot, options);
}
