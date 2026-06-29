import { createPromptCommandOutput } from "#setup/cli/index.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { spawnPackageManager } from "#setup/primitives/index.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import type { Prompter } from "../prompter.js";
import { withSpinner } from "../with-spinner.js";

export type InstallVercelCliResult =
  /** The CLI is already resolvable; nothing to do. */
  | { kind: "already" }
  /** The package manager installed it and it now resolves. */
  | { kind: "installed" }
  /** The install exited non-zero, or the CLI still isn't on PATH afterward. */
  | { kind: "failed" }
  /** The user interrupted (Ctrl-C / Esc) before the install finished. */
  | { kind: "cancelled" };

/** Injected for tests; defaults to the real probe, detection, and install. */
export interface InstallVercelCliDeps {
  getVercelAuthStatus: typeof getVercelAuthStatus;
  detectPackageManager: typeof detectPackageManager;
  spawnPackageManager: typeof spawnPackageManager;
}

const defaultDeps: InstallVercelCliDeps = {
  getVercelAuthStatus,
  detectPackageManager,
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

/**
 * THE INSTALL FLOW for the dev TUI's `/vc:install`: the fix command for the
 * "Vercel CLI not found" diagnostic, so every diagnostic has a matching
 * command. Short-circuits when the CLI already resolves; otherwise runs a
 * global install with the project's package manager, streaming output to the
 * rail, then re-probes. A global install can exit clean yet leave the binary
 * off PATH (pnpm/yarn global bins commonly aren't), so success is confirmed by
 * the re-probe, not the exit code alone.
 */
export async function runInstallVercelCliFlow(input: {
  appRoot: string;
  prompter: Prompter;
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

  if (await withSpinner(prompter, "Checking for the Vercel CLI…", probe)) {
    signal?.throwIfAborted();
    return { kind: "already" };
  }
  signal?.throwIfAborted();

  const manager = await deps.detectPackageManager(appRoot);
  const ok = await withSpinner(prompter, `Installing the Vercel CLI with ${manager.kind}…`, () =>
    deps.spawnPackageManager(manager.kind, appRoot, globalInstallArguments(manager.kind), {
      onOutput,
      signal,
      // A global install never prompts; closing stdin keeps it from contending
      // with the TUI's raw-mode key consumer.
      nonInteractive: true,
    }),
  );
  if (signal?.aborted === true) return { kind: "cancelled" };
  if (!ok) return { kind: "failed" };

  const present = await withSpinner(prompter, "Verifying the Vercel CLI…", probe);
  signal?.throwIfAborted();
  return present ? { kind: "installed" } : { kind: "failed" };
}
