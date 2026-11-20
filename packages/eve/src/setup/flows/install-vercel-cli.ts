import { createPromptCommandOutput } from "#setup/cli/index.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { resultSucceeded, runVercel, spawnPackageManager } from "#setup/primitives/index.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import type { Prompter } from "../prompter.js";
import { withSpinner } from "../with-spinner.js";

export type InstallVercelCliResult =
  | { kind: "already" }
  | { kind: "installed" }
  | { kind: "failed"; reason?: string }
  | { kind: "cancelled" };

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

export async function runInstallVercelCliFlow(input: {
  appRoot: string;
  prompter: Prompter;
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
    ok = await withSpinner(prompter, `Installing the Vercel CLI with ${manager.kind}…`, async () =>
      resultSucceeded(
        await deps.spawnPackageManager(
          manager.kind,
          appRoot,
          globalInstallArguments(manager.kind),
          {
            onOutput,
            signal,
            nonInteractive: true,
          },
        ),
      ),
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
