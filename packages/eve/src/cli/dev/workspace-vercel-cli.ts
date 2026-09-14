import { hasInteractiveTerminal } from "#cli/commands/preconditions.js";
import {
  offerVercelCliUpgrade,
  type OfferVercelCliUpgradeResult,
} from "#setup/flows/install-vercel-cli.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { detectVercelCliVersion, isVercelCliVersionSupported } from "#setup/vercel-cli.js";

export const MINIMUM_WORKSPACE_DEV_VERCEL_VERSION = "59.16.0";

interface WorkspaceVercelCliDeps {
  readonly createPrompter: () => Prompter;
  readonly detectVercelCliVersion: typeof detectVercelCliVersion;
  readonly hasInteractiveTerminal: () => boolean;
  readonly offerVercelCliUpgrade: (input: {
    readonly appRoot: string;
    readonly message: string;
    readonly prompter: Prompter;
    readonly upgradeLabel?: string;
  }) => Promise<OfferVercelCliUpgradeResult>;
}

const defaultDeps: WorkspaceVercelCliDeps = {
  createPrompter,
  detectVercelCliVersion,
  hasInteractiveTerminal,
  offerVercelCliUpgrade,
};

function unsupportedVersionMessage(version: string, detail?: string): string {
  const failure = detail === undefined ? "" : ` ${detail}`;
  return `Vercel CLI ${version} is too old. Workspace development requires ${MINIMUM_WORKSPACE_DEV_VERCEL_VERSION} or newer.${failure} Run \`vercel upgrade\`, then retry \`eve dev\`.`;
}

async function readVercelCliVersion(
  workspaceRoot: string,
  deps: WorkspaceVercelCliDeps,
): Promise<string> {
  const { version } = await deps.detectVercelCliVersion({ projectRoot: workspaceRoot });
  if (version === undefined) {
    throw new Error(
      `Vercel CLI ${MINIMUM_WORKSPACE_DEV_VERCEL_VERSION} or newer is required. Install it with \`npm i -g vercel@latest\`, then retry \`eve dev\`.`,
    );
  }
  return version;
}

/** Ensure the Vercel CLI can run eve's generated local workspace graph. */
export async function ensureWorkspaceVercelCli(input: {
  readonly workspaceRoot: string;
  readonly deps?: Partial<WorkspaceVercelCliDeps>;
}): Promise<void> {
  const deps: WorkspaceVercelCliDeps = { ...defaultDeps, ...input.deps };
  const installedVersion = await readVercelCliVersion(input.workspaceRoot, deps);
  if (isVercelCliVersionSupported(installedVersion, MINIMUM_WORKSPACE_DEV_VERCEL_VERSION)) return;
  if (!deps.hasInteractiveTerminal()) throw new Error(unsupportedVersionMessage(installedVersion));

  const prompter = deps.createPrompter();
  const result = await deps.offerVercelCliUpgrade({
    appRoot: input.workspaceRoot,
    message: `Vercel CLI ${installedVersion} is too old. Upgrade it now?`,
    prompter,
    upgradeLabel: "Upgrade Vercel CLI and continue",
  });
  if (result.kind !== "installed" && result.kind !== "already") {
    const detail =
      result.kind === "failed" && result.reason !== undefined
        ? `The upgrade failed: ${result.reason}.`
        : result.kind === "cancelled"
          ? "The upgrade was cancelled."
          : result.kind === "declined"
            ? undefined
            : "The upgrade failed.";
    throw new Error(unsupportedVersionMessage(installedVersion, detail));
  }

  const upgradedVersion = await readVercelCliVersion(input.workspaceRoot, deps);
  if (!isVercelCliVersionSupported(upgradedVersion, MINIMUM_WORKSPACE_DEV_VERCEL_VERSION)) {
    throw new Error(unsupportedVersionMessage(upgradedVersion));
  }
  prompter.log.success(`Upgraded Vercel CLI to ${upgradedVersion}.`);
}
