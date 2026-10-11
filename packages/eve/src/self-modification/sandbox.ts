import {
  defineSandbox,
  type RuntimeSandboxSession,
  type SandboxSelectorContext,
} from "#public/definitions/sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { bindSandboxEnvironment } from "#shared/sandbox-environment.js";

import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { createSelfModificationFilesystem } from "./filesystem.js";
import { isLocalSelfModificationEnabled } from "./mode.js";

export interface SelfModificationSandboxOptions {
  readonly config?: SelfModificationConfig;
}

export interface SelfModificationSandbox {
  (context: SandboxSelectorContext): Promise<RuntimeSandboxSession> | RuntimeSandboxSession;
}

/** Defines the local self-modification sandbox; source mounts exist only during development. */
export function defineSelfModificationSandbox(
  options: SelfModificationSandboxOptions = {},
): SelfModificationSandbox {
  const environment = isLocalSelfModificationEnabled(resolveSelfModificationConfig(options.config))
    ? JustBashSandbox.environment({ filesystem: createSelfModificationFilesystem })
    : JustBashSandbox.environment();
  return bindSandboxEnvironment(
    defineSandbox(() => environment.open()),
    environment,
  );
}

export default defineSelfModificationSandbox();
