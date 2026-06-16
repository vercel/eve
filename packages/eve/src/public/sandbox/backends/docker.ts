import { createDockerSandboxBackend } from "#execution/sandbox/bindings/local.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";

/**
 * Constructs the Docker sandbox backend: the workspace runs inside a
 * real Linux container driven through the Docker CLI, using the
 * official Ubuntu 26.04 image by default.
 *
 * Requires a running Docker-compatible daemon reachable through a
 * `docker` CLI (Docker Desktop, OrbStack, Colima, Podman via its
 * docker-compatible CLI, …; override the binary with `EVE_DOCKER_PATH`).
 * Configuring this backend pins it unconditionally — when you want
 * fallback behavior, use `defaultBackend()` instead.
 */
export function docker(opts?: DockerSandboxCreateOptions): SandboxBackend {
  return createDockerSandboxBackend({ createOptions: opts });
}
