import { createHash } from "node:crypto";

import { commandFailureDetail } from "#extensions/code/extension/lib/command-failure.js";
import { shellQuote } from "#extensions/code/extension/lib/shell.js";
import {
  installCodeTooling,
  CODE_TOOLING_REVALIDATION_KEY,
} from "#extensions/code/extension/lib/sandbox.js";
import { executeGitHubShell } from "#extensions/git/extension/lib/github-shell.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import {
  bindSandboxEnvironment,
  type SandboxEnvironment,
  type SandboxSelector,
} from "#shared/sandbox-environment.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

import { isDeployedRuntime } from "../mode.js";
import type { ResolvedDeployedSelfModificationConfig } from "./config-schema.js";
import { deployedGitHubConfig } from "./github.js";

const VERCEL_SANDBOX_REQUIRED_MESSAGE =
  "Deployed self-modification requires deploying on Vercel, where Vercel Sandbox provides the runtime credential transforms that keep the GitHub token out of the sandbox. Deploy this agent to Vercel, or remove the eve/self-modification/remote extension mount from self-hosted deployments.";

const isDeployedOnVercel = () => Boolean(process.env.VERCEL);

/**
 * Selects Vercel Sandbox, which can revoke brokered credentials after checkout.
 * Returns undefined rather than throwing: sandbox modules are evaluated by `eve build`
 * and `eve dev` on hosts that will never open this sandbox, and those builds must
 * not need Vercel credentials to prepare its snapshot. The build and the runtime both
 * evaluate this, so output built off Vercel and deployed to Vercel records no Vercel
 * template and fails loudly with `SandboxTemplateNotProvisionedError` on first open.
 */
export function createDeployedSelfModificationEnvironment(
  onVercel: () => boolean = isDeployedOnVercel,
): SandboxEnvironment | undefined {
  if (!onVercel()) return undefined;
  return VercelSandbox.environment({
    // This supported provider option participates in template identity, so a tooling
    // release cannot reuse a snapshot prepared by an older release.
    env: { EVE_CODE_TOOLING_REVALIDATION_KEY: CODE_TOOLING_REVALIDATION_KEY },
    prepare: prepareDeployedSelfModificationSandbox,
  });
}

/** Installs only reusable development tooling; checkouts and credentials are session-specific. */
export async function prepareDeployedSelfModificationSandbox(
  sandbox: Pick<SandboxSession, "run" | "resolvePath" | "writeTextFile">,
): Promise<void> {
  // The eve base image already provides Node.js, pnpm, Git, and ripgrep; install only
  // what a custom image lacks. Project package managers run through `corepack <pm>`.
  const result = await sandbox.run({
    command: [
      "set -eu",
      'missing=""',
      'command -v git >/dev/null 2>&1 || missing="$missing git"',
      'command -v rg >/dev/null 2>&1 || missing="$missing ripgrep"',
      'if [ -n "$missing" ] && command -v apt-get >/dev/null 2>&1; then',
      "  if [ \"$(id -u)\" = 0 ]; then APT=apt-get; else APT='sudo -n apt-get'; fi",
      "  $APT update",
      "  $APT install -y $missing",
      "fi",
      ...["node", "npm", "git", "rg"].map(
        (tool) =>
          `command -v ${tool} >/dev/null 2>&1 || { echo 'eve requires ${tool} in the deployed sandbox' >&2; exit 1; }`,
      ),
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to prepare deployed self-modification tooling (exit ${result.exitCode}): ${commandFailureDetail(result)}`,
    );
  }
  await installCodeTooling(sandbox);
}

/**
 * Clones the configured repository into the child sandbox and switches to its working branch.
 * Safe to repeat against the same sandbox. A replacement sandbox starts again from the base
 * branch rather than restoring unpublished work.
 */
export async function initializeDeployedCheckout(
  sandbox: SandboxSession,
  config: ResolvedDeployedSelfModificationConfig,
  sessionId: string,
): Promise<void> {
  const repository = config.github.repository;
  const checkout = sandbox.resolvePath("repository");
  // eve may rerun initialization against the same session sandbox, for example after
  // a later step failed, so an existing clone is reused instead of cloned again.
  const existing = await sandbox.run({
    command: `test -d ${shellQuote(`${checkout}/.git`)}`,
  });
  if (existing.exitCode !== 0) {
    await cloneConfiguredRepository(sandbox, config, sessionId);
  }
  const branch = `eve/selfmod-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
  const application = config.directory === "." ? checkout : `${checkout}/${config.directory}`;
  const initialized = await sandbox.run({
    command: [
      "set -eu",
      // The git extension's authenticated git commands resolve their target repository from origin.
      `git -C ${shellQuote(checkout)} remote set-url origin ${shellQuote(`https://github.com/${repository}.git`)}`,
      `if git -C ${shellQuote(checkout)} rev-parse --verify --quiet ${shellQuote(`refs/heads/${branch}`)} >/dev/null; then`,
      `  git -C ${shellQuote(checkout)} switch ${shellQuote(branch)}`,
      "else",
      `  git -C ${shellQuote(checkout)} switch -c ${shellQuote(branch)}`,
      "fi",
      `root=$(realpath -e -- ${shellQuote(checkout)})`,
      `app=$(realpath -e -- ${shellQuote(application)})`,
      `agent=$(realpath -e -- ${shellQuote(`${application}/agent`)})`,
      'case "$app" in "$root"|"$root"/*) ;; *) exit 2 ;; esac',
      'case "$agent" in "$root"/*) ;; *) exit 2 ;; esac',
      'test -d "$app" && test -d "$agent"',
    ].join("\n"),
  });
  if (initialized.exitCode !== 0) {
    throw new Error(
      `Could not initialize ${repository} at ${checkout}: verify the configured application directory and agent/ exist inside the checkout (exit ${initialized.exitCode}).`,
    );
  }
}

async function cloneConfiguredRepository(
  sandbox: SandboxSession,
  config: ResolvedDeployedSelfModificationConfig,
  sessionId: string,
): Promise<void> {
  const repository = config.github.repository;
  // A clone interrupted before git initialized the directory would block a new clone.
  await sandbox.removePath({
    path: sandbox.resolvePath("repository"),
    recursive: true,
    force: true,
  });
  const result = await executeGitHubShell(
    {
      command: `gh repo clone ${shellQuote(repository)} repository -- --branch ${shellQuote(config.baseBranch)} --single-branch`,
      description: `Clone the configured repository ${repository} at ${config.baseBranch} into the child workspace.`,
      permissions: [{ access: "write", provider: "github", repositories: [repository] }],
    },
    deployedGitHubConfig(config),
    { getSandbox: async () => sandbox, sessionId },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not check out configured repository ${repository} (exit ${result.exitCode}). Check the GitHub connector installation, repository permissions, and base branch ${config.baseBranch}.`,
    );
  }
}

/**
 * Defines the deployed child's sandbox. During `eve dev`, or off Vercel, it binds
 * an inert environment and fails only when opened.
 */
export function defineDeployedSelfModificationSandbox(
  config: ResolvedDeployedSelfModificationConfig,
  onVercel?: () => boolean,
): SandboxSelector {
  const deployed = isDeployedRuntime();
  const environment = deployed ? createDeployedSelfModificationEnvironment(onVercel) : undefined;
  return bindSandboxEnvironment(
    defineSandbox(async ({ session }) => {
      if (!deployed) {
        throw new Error("Deployed self-modification is unavailable during eve dev.");
      }
      if (environment === undefined) throw new Error(VERCEL_SANDBOX_REQUIRED_MESSAGE);
      const sandbox = await environment.open();
      await initializeDeployedCheckout(sandbox, config, session.id);
      return sandbox;
    }),
    environment ?? JustBashSandbox.environment(),
  );
}
