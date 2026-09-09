import { shellQuote } from "#shared/shell-quote.js";
import { SANDBOX_BACKEND_PROBES, type DefaultSandboxProbes } from "#sandbox/backends/default.js";
import {
  defaultBackend,
  defineSandbox,
  type SandboxBackend,
  type SandboxDefinition,
} from "#public/sandbox/index.js";
import { justbash } from "#public/sandbox/just-bash.js";
import { microsandbox } from "#public/sandbox/microsandbox.js";
import { vercel } from "#public/sandbox/vercel.js";

import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { createGitHubCredentialProvider } from "./credentials.js";
import { createSelfModificationFilesystem } from "./filesystem.js";
import { prepareSelfModificationWorkspace, REPOSITORY_PATH } from "./git-workspace.js";
import { resolveSelfModificationMode } from "./mode.js";
import { SELF_MODIFICATION_BASELINE_NETWORK_POLICY } from "./network-policy.js";

export interface SelfModificationSandboxOptions {
  /**
   * Production backend. Deployed self-modification owns an allow-all network
   * policy and temporarily adds a credential transform while checking out its
   * source. When omitted, eve selects Vercel Sandbox on Vercel or microsandbox
   * on a supported self-hosted system.
   */
  readonly backend?: SandboxBackend;
  /** Policy shared with the agent and extension mount. */
  readonly config?: SelfModificationConfig;
}

type SelfModificationSandboxProbes = Pick<
  DefaultSandboxProbes,
  "isDeployedOnVercel" | "isMicrosandboxSupported"
>;

/** Defines the local source mount or isolated production proposal workspace. */
export function defineSelfModificationSandbox(
  options: SelfModificationSandboxOptions = {},
): SandboxDefinition {
  const config = resolveSelfModificationConfig(options.config);

  return defineSandbox({
    backend: () => {
      const mode = resolveSelfModificationMode(config);
      if (mode === "local") return justbash({ filesystem: createSelfModificationFilesystem });
      if (mode === "disabled") return options.backend ?? defaultBackend();
      return selectDeployedSelfModificationBackend(options.backend, SANDBOX_BACKEND_PROBES);
    },
    async onSession({ ctx, use }) {
      if (resolveSelfModificationMode(config) !== "deployed" || config.deployed === undefined)
        return;
      if (ctx.session.parent === undefined) {
        throw new Error(
          "Production self-modification workspaces require a delegated child session.",
        );
      }

      const deployed = config.deployed;
      const sandbox = await use();
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
      const applicationRoot =
        deployed.directory === "." ? REPOSITORY_PATH : `${REPOSITORY_PATH}/${deployed.directory}`;
      const mounted = await sandbox.run({
        command: `rm -rf /source && ln -s ${shellQuote(`${applicationRoot}/agent`)} /source`,
      });
      if (mounted.exitCode !== 0) {
        throw new Error("Self-modification could not mount the production agent source.");
      }
    },
  });
}

/**
 * Deployed self-modification deliberately selects a backend that can inject
 * GitHub auth at the network boundary, keeping the credential outside the
 * sandbox and agent. Docker and just-bash do not provide that separation.
 * Internal—exported for tests, which inject availability probes.
 */
export function selectDeployedSelfModificationBackend(
  configured: SandboxBackend | undefined,
  probes: SelfModificationSandboxProbes,
): SandboxBackend {
  if (configured !== undefined) {
    if (configured.name === "vercel" || configured.name === "microsandbox") return configured;
    throw unsupportedBackend(configured.name);
  }
  if (probes.isDeployedOnVercel()) {
    return vercel({ networkPolicy: SELF_MODIFICATION_BASELINE_NETWORK_POLICY });
  }
  if (probes.isMicrosandboxSupported()) {
    return microsandbox({ networkPolicy: SELF_MODIFICATION_BASELINE_NETWORK_POLICY });
  }
  throw unsupportedBackend();
}

function unsupportedBackend(name?: string): Error {
  const reason =
    name === undefined
      ? "No supported backend is available."
      : `The configured ${name} backend does not support them.`;
  return new Error(
    `Deployed self-modification requires runtime credential transforms. ${reason} Use vercel() on Vercel or microsandbox() on a supported self-hosted system.`,
  );
}

export default defineSelfModificationSandbox();
