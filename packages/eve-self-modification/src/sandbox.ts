import {
  defaultBackend,
  defineSandbox,
  type SandboxBackend,
  type SandboxDefinition,
} from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { vercel } from "eve/sandbox/vercel";

import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { createSelfModificationFilesystem } from "./filesystem.js";
import { prepareSelfModificationWorkspace } from "./git-workspace.js";
import { resolveSelfModificationMode } from "./mode.js";
import {
  assertSelfModificationPullRequestsAvailable,
  resolvePersonalAccessToken,
} from "./pull-requests.js";

export interface SelfModificationSandboxOptions {
  readonly backend?: SandboxBackend;
  /** Shared self-modification policy. */
  readonly config?: SelfModificationConfig;
}

export function defineSelfModificationSandbox(
  options: SelfModificationSandboxOptions = {},
): SandboxDefinition {
  const config = resolveSelfModificationConfig(options.config);

  return defineSandbox({
    backend: () => {
      const mode = resolveSelfModificationMode(config);
      if (mode === "development") {
        return justbash({ filesystem: createSelfModificationFilesystem });
      }
      if (process.env.VERCEL) return vercel();
      return options.backend ?? defaultBackend();
    },
    async onSession({ use }) {
      if (resolveSelfModificationMode(config) !== "pull-requests") return;
      if (config.pullRequests === undefined) return;
      const source = assertSelfModificationPullRequestsAvailable({
        pullRequests: config.pullRequests,
      });
      const sandbox = await use();
      await prepareSelfModificationWorkspace({
        deployedSha: source.revision,
        token: resolvePersonalAccessToken(),
        repository: config.pullRequests.repository,
        rootDirectory: source.rootDirectory,
        sandbox,
      });
    },
  });
}

export default defineSelfModificationSandbox();
