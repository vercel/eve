import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/** Live sandbox capabilities exposed by a microsandbox environment. */
export interface MicrosandboxSandboxSession extends SandboxSession {
  /** Applies a firewall policy to the live microsandbox VM. */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

export {
  MicrosandboxSandbox,
  type MicrosandboxEnvironmentOptions,
} from "#sandbox/providers/microsandbox.js";
export type { MicrosandboxSandboxRuntimeOptions } from "#public/sandbox/microsandbox-sandbox.js";
