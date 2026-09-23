import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/** Sandbox session capability exposed by environments with mutable networking. */
export interface NetworkPolicySandboxSession extends SandboxSession {
  /** Applies a firewall policy to the live sandbox. */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}
