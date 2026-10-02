import { defineSandbox } from "#public/definitions/sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { MicrosandboxSandbox } from "#sandbox/providers/microsandbox.js";
import { SANDBOX_PROVIDER_PROBES, type DefaultSandboxProbes } from "#sandbox/providers/default.js";
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
} from "./deployed/config.js";

type Probes = Pick<DefaultSandboxProbes, "isDeployedOnVercel" | "isMicrosandboxSupported">;
type DeployedSelfModificationEnvironment =
  | ReturnType<typeof MicrosandboxSandbox.environment>
  | ReturnType<typeof VercelSandbox.environment>;

/**
 * Defines the deployed child's sandbox. During `eve dev` the deployed child is never
 * offered, so its sandbox binds an inert environment instead of probing providers.
 */
export function defineDeployedSelfModificationSandbox(
  config: DeployedSelfModificationConfig,
  probes: Probes = SANDBOX_PROVIDER_PROBES,
): SandboxSelector {
  if (!isDeployedRuntime()) {
    const environment = JustBashSandbox.environment();
    return bindSandboxEnvironment(
      defineSandbox(() => environment.open()),
      environment,
    );
  }

  const deployed = resolveDeployedSelfModificationConfig(config);
  const environment = selectDeployedSelfModificationEnvironment(probes);
  return bindSandboxEnvironment(
    defineSandbox(async ({ session }) => {
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

export function selectDeployedSelfModificationEnvironment(
  probes: Probes,
): DeployedSelfModificationEnvironment {
  if (probes.isDeployedOnVercel()) {
    return VercelSandbox.environment();
  }
  if (probes.isMicrosandboxSupported()) {
    return MicrosandboxSandbox.environment();
  }
  throw new Error(
    "Deployed self-modification requires runtime credential transforms. No supported provider is available. Use Vercel Sandbox or microsandbox on a supported self-hosted system.",
  );
}
