import type { SandboxSession } from "#shared/sandbox-session.js";
import type { DockerSandboxNetworkPolicy } from "#public/sandbox/docker-sandbox.js";

/** Live sandbox capabilities exposed by a Docker environment. */
export interface DockerSandboxSession extends SandboxSession {
  /** Applies a coarse egress policy to the live container. */
  setNetworkPolicy(policy: DockerSandboxNetworkPolicy): Promise<void>;
}

export {
  DockerSandbox,
  type DockerSandboxEnvironmentOptions,
  type DockerSandboxRuntimeOptions,
} from "#sandbox/providers/docker.js";
export type {
  DockerSandboxNetworkPolicy,
  DockerSandboxPullPolicy,
} from "#public/sandbox/docker-sandbox.js";
