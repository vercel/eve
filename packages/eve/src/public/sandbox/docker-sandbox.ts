import type { SandboxSession } from "#shared/sandbox-session.js";
import type {
  SandboxNetworkOptions,
  SandboxNetworkPolicy,
} from "#shared/sandbox-network-policy.js";

/** Image pull behavior for Docker sandbox environments. */
export type DockerSandboxPullPolicy = "if-not-present" | "always" | "never";

/** Coarse-grained egress policy for one live Docker sandbox. */
export type DockerSandboxNetworkPolicy = Extract<SandboxNetworkPolicy, "allow-all" | "deny-all">;

/** Options shared by every sandbox created from one Docker environment. */
export interface DockerSandboxEnvironmentOptions {
  /** Base container image. Defaults to eve's published sandbox image. */
  readonly image?: string;
  /** Environment variables baked into template builds and live containers. */
  readonly env?: Readonly<Record<string, string>>;
  /** Base image pull behavior. @default "if-not-present" */
  readonly pullPolicy?: DockerSandboxPullPolicy;
  /** Idempotent setup captured in the prepared image. */
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
}

/** Options applied when eve creates one live Docker sandbox. */
export interface DockerSandboxRuntimeOptions extends SandboxNetworkOptions {
  /** Initial network policy for this container. @default "allow-all" */
  readonly networkPolicy?: DockerSandboxNetworkPolicy;
}
