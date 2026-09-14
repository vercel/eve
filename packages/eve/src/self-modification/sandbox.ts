import { defineSandbox, type SandboxSelector } from "#public/definitions/sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { MicrosandboxSandbox } from "#sandbox/providers/microsandbox.js";
import { SANDBOX_PROVIDER_PROBES, type DefaultSandboxProbes } from "#sandbox/providers/default.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import {
  bindSandboxEnvironment,
  type SandboxEnvironmentIdentity,
} from "#shared/sandbox-environment.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#shared/shell-quote.js";
import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { createGitHubCredentialProvider } from "./credentials.js";
import { createSelfModificationFilesystem } from "./filesystem.js";
import { prepareSelfModificationWorkspace, REPOSITORY_PATH } from "./git-workspace.js";
import { resolveSelfModificationMode } from "./mode.js";
import { SELF_MODIFICATION_BASELINE_NETWORK_POLICY } from "./network-policy.js";

export interface SelfModificationSandboxOptions {
  readonly config?: SelfModificationConfig;
}

type Probes = Pick<DefaultSandboxProbes, "isDeployedOnVercel" | "isMicrosandboxSupported">;
type SelfModificationEnvironment = SandboxEnvironmentIdentity & {
  create(): Promise<RuntimeSandboxSession>;
};

export function defineSelfModificationSandbox(
  options: SelfModificationSandboxOptions = {},
): SandboxSelector {
  const config = resolveSelfModificationConfig(options.config);
  const mode = resolveSelfModificationMode(config);
  const environment =
    mode === "local"
      ? JustBashSandbox.environment({ filesystem: createSelfModificationFilesystem })
      : mode === "disabled"
        ? JustBashSandbox.environment()
        : selectDeployedSelfModificationEnvironment(SANDBOX_PROVIDER_PROBES);

  return bindSandboxEnvironment(
    defineSandbox(async ({ session }) => {
      const sandbox = await environment.create();
      if (mode !== "deployed" || config.deployed === undefined) return sandbox;
      if (session.parent === undefined)
        throw new Error("Production self-modification requires a child session.");
      const deployed = config.deployed;
      await sandbox.setNetworkPolicy(SELF_MODIFICATION_BASELINE_NETWORK_POLICY);
      const token = await createGitHubCredentialProvider(deployed.credentials).resolve({
        capability: "checkout",
        repository: deployed.repository,
      });
      await prepareSelfModificationWorkspace({
        directory: deployed.directory,
        repository: deployed.repository,
        sandbox,
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
): SelfModificationEnvironment {
  if (probes.isDeployedOnVercel()) {
    return VercelSandbox.environment({
      networkPolicy: SELF_MODIFICATION_BASELINE_NETWORK_POLICY,
    });
  }
  if (probes.isMicrosandboxSupported()) {
    return MicrosandboxSandbox.environment({
      networkPolicy: SELF_MODIFICATION_BASELINE_NETWORK_POLICY,
    });
  }
  throw new Error(
    "Deployed self-modification requires runtime credential transforms. No supported provider is available. Use Vercel Sandbox or microsandbox on a supported self-hosted system.",
  );
}

export default defineSelfModificationSandbox();
