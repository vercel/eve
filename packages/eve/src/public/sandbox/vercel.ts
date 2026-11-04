import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/** Live sandbox capabilities exposed by a Vercel environment. */
export interface VercelSandboxSession extends SandboxSession {
  /** Name of the live Vercel Sandbox (stable across stop/resume for the session). */
  readonly name: string;
  /**
   * Reads the live Vercel Sandbox's firewall policy from the API, including
   * writes made through other handles. Header values a rule injects come back
   * as `"<redacted>"`; match values come back as written.
   */
  getNetworkPolicy(): Promise<SandboxNetworkPolicy>;
  /** Applies a firewall policy to the live Vercel Sandbox. */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

export {
  VercelSandbox,
  type VercelSandboxEnvironmentOptions,
  type VercelSandboxRuntimeOptions,
} from "#sandbox/providers/vercel.js";
export type {
  VercelSandboxCreateOptions,
  VercelSandboxMount,
  VercelSandboxMountMode,
  VercelSandboxMounts,
} from "#public/sandbox/vercel-sandbox.js";
