import {
  defineSandbox,
  type RuntimeSandboxSession,
  type SandboxSelectorContext,
} from "#public/definitions/sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { MicrosandboxSandbox } from "#sandbox/providers/microsandbox.js";
import { SANDBOX_PROVIDER_PROBES, type DefaultSandboxProbes } from "#sandbox/providers/default.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import { bindSandboxEnvironment } from "#shared/sandbox-environment.js";
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

export interface SelfModificationSandbox {
  (context: SandboxSelectorContext): Promise<RuntimeSandboxSession> | RuntimeSandboxSession;
}

type Probes = Pick<DefaultSandboxProbes, "isDeployedOnVercel" | "isMicrosandboxSupported">;
type DeployedSelfModificationEnvironment =
  | ReturnType<typeof MicrosandboxSandbox.environment>
  | ReturnType<typeof VercelSandbox.environment>;

export function defineSelfModificationSandbox(
  options: SelfModificationSandboxOptions = {},
): SelfModificationSandbox {
  const config = resolveSelfModificationConfig(options.config);
  const mode = resolveSelfModificationMode(config);
  if (mode !== "deployed") {
    const environment =
      mode === "local"
        ? JustBashSandbox.environment({ filesystem: createSelfModificationFilesystem })
        : JustBashSandbox.environment();
    return bindSandboxEnvironment(
      defineSandbox(() => environment.open()),
      environment,
    );
  }

  const environment = selectDeployedSelfModificationEnvironment(SANDBOX_PROVIDER_PROBES);
  return bindSandboxEnvironment(
    defineSandbox(async ({ session }) => {
      const sandbox = await environment.open({
        networkPolicy: SELF_MODIFICATION_BASELINE_NETWORK_POLICY,
      });
      if (config.deployed === undefined) return sandbox;
      if (session.parent === undefined)
        throw new Error("Production self-modification requires a child session.");
      if (sandbox.setNetworkPolicy === undefined) {
        throw new Error("Production self-modification requires mutable sandbox network policy.");
      }
      const capableSandbox = { ...sandbox, setNetworkPolicy: sandbox.setNetworkPolicy };
      const deployed = config.deployed;
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

export default defineSelfModificationSandbox();
