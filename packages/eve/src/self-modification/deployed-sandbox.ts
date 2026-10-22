import { defineSandbox } from "#public/definitions/sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import { bindSandboxEnvironment, type SandboxSelector } from "#shared/sandbox-environment.js";
import { shellQuote } from "#shared/shell-quote.js";

import { createGitHubCredentialProvider } from "./credentials.js";
import { prepareSelfModificationWorkspace, REPOSITORY_PATH } from "./git-workspace.js";
import { isDeployedRuntime } from "./mode.js";
import { SELF_MODIFICATION_BASELINE_NETWORK_POLICY } from "./network-policy.js";
import {
  resolveDeployedSelfModificationConfig,
  type DeployedSelfModificationConfig,
} from "./remote/config.js";

const VERCEL_SANDBOX_REQUIRED_MESSAGE =
  "Deployed self-modification requires deploying on Vercel, where Vercel Sandbox provides the runtime credential transforms that keep the GitHub token out of the sandbox. Deploy this agent to Vercel, or remove the eve/self-modification/remote extension mount from self-hosted deployments.";

/**
 * Defines the deployed child's sandbox. During `eve dev` the deployed child is never
 * offered, so its sandbox binds an inert environment. Other builds bind a Vercel
 * environment, whose empty preparation is a no-op, so they compile on any host;
 * the Vercel requirement is enforced when a deployed child opens its sandbox.
 */
export function defineDeployedSelfModificationSandbox(
  config: DeployedSelfModificationConfig,
  isDeployedOnVercel: () => boolean = () => Boolean(process.env.VERCEL),
): SandboxSelector {
  if (!isDeployedRuntime()) {
    const environment = JustBashSandbox.environment();
    return bindSandboxEnvironment(
      defineSandbox(() => environment.open()),
      environment,
    );
  }

  const deployed = resolveDeployedSelfModificationConfig(config);
  const environment = VercelSandbox.environment();
  return bindSandboxEnvironment(
    defineSandbox(async ({ session }) => {
      if (!isDeployedOnVercel()) throw new Error(VERCEL_SANDBOX_REQUIRED_MESSAGE);
      const sandbox = await environment.open({
        networkPolicy: SELF_MODIFICATION_BASELINE_NETWORK_POLICY,
      });
      if (session.parent === undefined)
        throw new Error("Production self-modification requires a child session.");
      if (sandbox.setNetworkPolicy === undefined) {
        throw new Error("Production self-modification requires mutable sandbox network policy.");
      }
      const capableSandbox = { ...sandbox, setNetworkPolicy: sandbox.setNetworkPolicy };
      const token = await createGitHubCredentialProvider(deployed.credentials).resolve({
        capability: "checkout",
        repository: deployed.repository,
      });
      await prepareSelfModificationWorkspace({
        directory: deployed.directory,
        repository: deployed.repository,
        sandbox: capableSandbox,
        targetBranch: deployed.targetBranch,
        token,
      });
      const root =
        deployed.directory === "." ? REPOSITORY_PATH : `${REPOSITORY_PATH}/${deployed.directory}`;
      const result = await sandbox.run({
        command: `rm -rf /source && ln -s ${shellQuote(`${root}/agent`)} /source`,
      });
      if (result.exitCode !== 0)
        throw new Error("Self-modification could not mount the agent source.");
      return sandbox;
    }),
    environment,
  );
}
