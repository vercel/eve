/**
 * Image pull behavior for the Docker sandbox backend.
 *
 * - `"if-not-present"` (default): pull the base image only when it is
 *   missing from the local image store.
 * - `"always"`: pull before every template build so the image floats to
 *   the registry's latest digest.
 * - `"never"`: never pull; fail when the image is missing locally.
 */
export type DockerSandboxPullPolicy = "if-not-present" | "always" | "never";

/**
 * Initial network policy for sandboxes created by the Docker backend.
 * Docker supports coarse-grained egress control only: `"allow-all"`
 * attaches the container to the default bridge network, `"deny-all"`
 * runs it with networking disabled. Domain-level policies and
 * credential brokering require `vercel()`.
 */
export type DockerSandboxNetworkPolicy = "allow-all" | "deny-all";

/**
 * Options accepted by `docker(opts)`.
 */
export interface DockerSandboxCreateOptions {
  /**
   * Base container image for templates and sessions. Defaults to
   * `ghcr.io/vercel/eve:latest` — eve's published sandbox runtime image.
   * Framework setup creates `/workspace` and verifies Bash. Install any
   * authored runtime tools in sandbox bootstrap or provide them through a
   * custom image.
   */
  readonly image?: string;
  /**
   * Environment variables baked into every container the backend
   * creates (template builds and sessions).
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Base image pull behavior. Defaults to `"if-not-present"`.
   */
  readonly pullPolicy?: DockerSandboxPullPolicy;
  /**
   * Initial network policy for created containers. Defaults to
   * `"allow-all"`.
   */
  readonly networkPolicy?: DockerSandboxNetworkPolicy;
}
