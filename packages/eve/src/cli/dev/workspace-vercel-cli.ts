import semver from "#compiled/semver/index.js";
import { hasInteractiveTerminal } from "#cli/commands/preconditions.js";
import { captureVercel } from "#setup/primitives/run-vercel.js";
import { runInstallVercelCliFlow } from "#setup/flows/install-vercel-cli.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";

export const MINIMUM_WORKSPACE_DEV_VERCEL_VERSION = "59.16.0";

interface WorkspaceVercelCliDeps {
  readonly captureVercel: typeof captureVercel;
  readonly createPrompter: () => Prompter;
  readonly hasInteractiveTerminal: () => boolean;
  readonly runInstallVercelCliFlow: typeof runInstallVercelCliFlow;
}

const defaultDeps: WorkspaceVercelCliDeps = {
  captureVercel,
  createPrompter,
  hasInteractiveTerminal,
  runInstallVercelCliFlow,
};

async function readVercelCliVersion(
  workspaceRoot: string,
  deps: WorkspaceVercelCliDeps,
): Promise<string> {
  const result = await deps.captureVercel(["--version"], {
    cwd: workspaceRoot,
    nonInteractive: true,
  });
  if (!result.ok) {
    throw new Error(
      `Vercel CLI ${MINIMUM_WORKSPACE_DEV_VERCEL_VERSION} or newer is required. Install it with \`npm i -g vercel@latest\`, then retry \`eve dev\`.`,
    );
  }
  const version = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u.exec(result.stdout)?.[0];
  if (version === undefined || semver.validRange(version) === null) {
    throw new Error(
      `Could not determine the Vercel CLI version. Install Vercel CLI ${MINIMUM_WORKSPACE_DEV_VERCEL_VERSION} or newer, then retry \`eve dev\`.`,
    );
  }
  return version;
}

function unsupportedVersionMessage(version: string, detail?: string): string {
  const failure = detail === undefined ? "" : ` ${detail}`;
  return `Vercel CLI ${version} is too old. Workspace development requires ${MINIMUM_WORKSPACE_DEV_VERCEL_VERSION} or newer.${failure} Run \`vercel upgrade\`, then retry \`eve dev\`.`;
}

/** Ensure the Vercel CLI can run eve's generated local workspace graph. */
export async function ensureWorkspaceVercelCli(input: {
  readonly workspaceRoot: string;
  readonly deps?: Partial<WorkspaceVercelCliDeps>;
}): Promise<void> {
  const deps: WorkspaceVercelCliDeps = { ...defaultDeps, ...input.deps };
  const installedVersion = await readVercelCliVersion(input.workspaceRoot, deps);
  if (semver.subset(installedVersion, `>=${MINIMUM_WORKSPACE_DEV_VERCEL_VERSION}`)) return;
  if (!deps.hasInteractiveTerminal()) throw new Error(unsupportedVersionMessage(installedVersion));

  const prompter = deps.createPrompter();
  let choice: "upgrade" | "cancel";
  try {
    choice = await prompter.select({
      message: `Vercel CLI ${installedVersion} is too old. Upgrade it now?`,
      options: [
        {
          label: "Upgrade Vercel CLI and continue",
          value: "upgrade",
        },
        { label: "Not now", value: "cancel" },
      ],
      initialValue: "upgrade",
    });
  } catch {
    choice = "cancel";
  }
  if (choice === "cancel") throw new Error(unsupportedVersionMessage(installedVersion));

  const result = await deps.runInstallVercelCliFlow({
    appRoot: input.workspaceRoot,
    prompter,
    upgrade: true,
  });
  if (result.kind !== "installed" && result.kind !== "already") {
    const detail =
      result.kind === "failed" && result.reason !== undefined
        ? `The upgrade failed: ${result.reason}.`
        : result.kind === "cancelled"
          ? "The upgrade was cancelled."
          : "The upgrade failed.";
    throw new Error(unsupportedVersionMessage(installedVersion, detail));
  }

  const upgradedVersion = await readVercelCliVersion(input.workspaceRoot, deps);
  if (!semver.subset(upgradedVersion, `>=${MINIMUM_WORKSPACE_DEV_VERCEL_VERSION}`)) {
    throw new Error(unsupportedVersionMessage(upgradedVersion));
  }
  prompter.log.success(`Upgraded Vercel CLI to ${upgradedVersion}.`);
}
