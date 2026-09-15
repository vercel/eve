import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/** Live sandbox capabilities exposed by a Vercel environment. */
export interface VercelSandboxSession extends SandboxSession {
  /** Applies a firewall policy to the live Vercel Sandbox. */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

export { ExperimentalVercelDockerfile } from "#sandbox/providers/vercel-image.js";
export {
  VercelSandbox,
  type VercelSandboxEnvironmentOptions,
  type VercelSandboxRuntimeOptions,
} from "#sandbox/providers/vercel.js";
export { Drive } from "#compiled/@vercel/sandbox/index.js";
export type {
  ExperimentalVercelImageEnvironmentOptions,
  ExperimentalVercelImageRuntimeOptions,
} from "#public/sandbox/vercel-image-sandbox.js";
export type {
  VercelSandboxMount,
  VercelSandboxMountMode,
  VercelSandboxMounts,
} from "#public/sandbox/vercel-sandbox.js";
