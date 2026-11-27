import { getLocalDevCapability } from "eve/local-dev";

import {
  defineSandbox,
  type RuntimeSandboxSession,
  type SandboxSelectorContext,
} from "#public/definitions/sandbox.js";
import { HostSandbox } from "#sandbox/providers/host.js";
import { bindSandboxEnvironment } from "#shared/sandbox-environment.js";

import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { createDisabledSelfModificationSandbox } from "./disabled-sandbox.js";
import { isLocalSelfModificationEnabled } from "./mode.js";

export interface SelfModificationSandboxOptions {
  readonly config?: SelfModificationConfig;
}

export interface SelfModificationSandbox {
  (context: SandboxSelectorContext): Promise<RuntimeSandboxSession> | RuntimeSandboxSession;
}

export function defineSelfModificationSandbox(
  options: SelfModificationSandboxOptions = {},
): SelfModificationSandbox {
  if (!isLocalSelfModificationEnabled(resolveSelfModificationConfig(options.config))) {
    return createDisabledSelfModificationSandbox();
  }
  const environment = HostSandbox.environment();
  return bindSandboxEnvironment(
    defineSandbox(() => {
      const capability = getLocalDevCapability();
      if (capability === undefined) {
        throw new Error(
          "Self-modification requires eve dev facilities for the authored source tree and watcher.",
        );
      }
      return environment.open({ cwd: capability.appRoot });
    }),
    environment,
  );
}

export default defineSelfModificationSandbox();
