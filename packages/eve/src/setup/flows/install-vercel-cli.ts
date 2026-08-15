import { createPromptCommandOutput } from "#setup/cli/index.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { runVercel, spawnPackageManager } from "#setup/primitives/index.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import type { Prompter } from "../prompter.js";
import { withSpinner } from "../with-spinner.js";

export type InstallVercelCliResult =
  /** The CLI is already resolvable; nothing to do. */
  | { kind: "already" }
  /** The package manager installed it and it now resolves. */
  | { kind: "installed" }
  /** The install exited non-zero, or the CLI still isn't on PATH afterward. */
  | { kind: "failed"; reason?: string }
  /** The user interrupted (Ctrl-C / Esc) before the install finished. */
  | { kind: "cancelled" };

/** Injected for tests; defaults to the real probe, detection, and install. */
export interface InstallVercelCliDeps {
  getVercelAuthStatus: typeof getVercelAuthStatus;
  detectPackageManager: typeof detectPackageManager;
  runVercel: typeof runVercel;
  spawnPackageManager: typeof spawnPackageManager;
}

const defaultDeps: InstallVercelCliDeps = {
  getVercelAuthStatus,
  detectPackageManager,
  runVercel,
  spawnPackageManager,
};

/** The global-install argv per package manager (`vercel@latest`, account-wide). */
function globalInstallArguments(kind: PackageManagerKind): string[] {
  switch (kind) {
    case "npm":
      return ["install", "-g", "vercel@latest"];
    case "yarn":
      return ["global", "add", "vercel@latest"];
    case "pnpm":
    case "bun":
      return ["add", "-g", "vercel@latest"];
  }
}

const MAX_UPGRADE_FAILURE_LENGTH = 240;

/** Picks one useful stderr line without exposing a whole stack trace in the TUI outcome. */
function summarizeUpgradeFailure(stderr: readonly string[]): string | undefined {
  const lines = stderr
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter(
      (line) =>
        line !== "" &&
        line !== "}" &&
        !line.startsWith("at ") &&
        !/^vercel upgrade exited with code \d+\.$/u.test(line),
    );
  const detail =
    lines.find((line) => /^(?:error\b|err_|.*\b(?:cannot|failed|could not)\b)/iu.test(line)) ??
    lines.at(-1);
  if (detail === undefined) return undefined;
  return detail.length <= MAX_UPGRADE_FAILURE_LENGTH
    ? detail
    : `${detail.slice(0, MAX_UPGRADE_FAILURE_LENGTH - 1)}…`;
}

/**
 * THE INSTALL FLOW for the dev TUI's `/vc:install`: the fix command for the
 * "Vercel CLI not found" diagnostic, so every diagnostic has a matching
 * command. Short-circuits when the CLI already resolves; otherwise runs a
 * global install with the project's package manager, streaming output to the
 * rail, then re-probes. A global install can exit clean yet leave the binary
 * off PATH (pnpm/yarn global bins commonly aren't), so success is confirmed by
 * the re-probe, not the exit code alone. `upgrade` invokes the active Vercel
 * CLI's native upgrader so it can update the installation that owns that
 * executable, independent of the project's package manager.
 */
export async function runInstallVercelCliFlow(input: {
  appRoot: string;
  prompter: Prompter;
  /** Reinstall the latest CLI even when an existing binary resolves. */
  upgrade?: boolean;
  signal?: AbortSignal;
  deps?: Partial<InstallVercelCliDeps>;
}): Promise<InstallVercelCliResult> {
  const { appRoot, prompter, signal } = input;
  const deps: InstallVercelCliDeps = { ...defaultDeps, ...input.deps };
  const onOutput = createPromptCommandOutput(prompter.log);

  const probe = async (): Promise<boolean> => {
    const status = await deps.getVercelAuthStatus(appRoot, { signal });
    return status !== "cli-missing";
  };

  if (!input.upgrade && (await withSpinner(prompter, "Checking for the Vercel CLI…", probe))) {
    signal?.throwIfAborted();
    return { kind: "already" };
  }
  signal?.throwIfAborted();

  let ok: boolean;
  let failureReason: string | undefined;
  if (input.upgrade) {
    const stderr: string[] = [];
    ok = await withSpinner(prompter, "Upgrading the Vercel CLI…", async () => {
      const upgraded = await deps.runVercel(["upgrade"], {
        cwd: appRoot,
        onOutput: (line) => {
          onOutput(line);
          if (line.stream === "stderr") stderr.push(line.text);
        },
        signal,
        nonInteractive: true,
      });
      if (!upgraded) failureReason = summarizeUpgradeFailure(stderr);
      return upgraded;
    });
  } else {
    const manager = await deps.detectPackageManager(appRoot);
    ok = await withSpinner(prompter, `Installing the Vercel CLI with ${manager.kind}…`, () =>
      deps.spawnPackageManager(manager.kind, appRoot, globalInstallArguments(manager.kind), {
        onOutput,
        signal,
        // A global install never prompts; closing stdin keeps it from contending
        // with the TUI's raw-mode key consumer.
        nonInteractive: true,
      }),
    );
  }
  if (signal?.aborted === true) return { kind: "cancelled" };
  if (!ok) {
    return failureReason === undefined
      ? { kind: "failed" }
      : { kind: "failed", reason: failureReason };
  }

  const present = await withSpinner(prompter, "Verifying the Vercel CLI…", probe);
  signal?.throwIfAborted();
  if (present) return { kind: "installed" };
  return input.upgrade
    ? {
        kind: "failed",
        reason: "The Vercel CLI could not be found after the upgrade completed.",
      }
    : { kind: "failed" };
}
