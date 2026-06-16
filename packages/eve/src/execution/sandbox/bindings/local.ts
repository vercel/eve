/**
 * Facade over every local sandbox backend (Docker, just-bash,
 * microsandbox) plus their availability probes and cache pruning.
 *
 * This module is the single import path for local-engine functionality
 * from the public surface, so the hosted (Vercel) server bundle can
 * prune all of it by stubbing one module — see
 * `createCompiledSandboxBackendPrunePlugin`. Anything exported here
 * must also exist on that stub.
 */
import {
  DockerDaemonUnavailableError,
  DockerUnavailableError,
} from "#execution/sandbox/bindings/docker-cli.js";
import { pruneDockerSandboxTemplates } from "#execution/sandbox/bindings/docker.js";
import { pruneJustBashSandboxTemplates } from "#execution/sandbox/bindings/just-bash.js";
import { pruneMicrosandboxTemplates } from "#execution/sandbox/bindings/microsandbox.js";

export {
  createDockerSandboxBackend,
  DOCKER_BACKEND_NAME,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker.js";
export { isDockerDaemonAvailableSync } from "#execution/sandbox/bindings/docker-cli.js";
export {
  createJustBashSandboxBackend,
  JUST_BASH_BACKEND_NAME,
  pruneJustBashSandboxTemplates,
} from "#execution/sandbox/bindings/just-bash.js";
export {
  createMicrosandboxSandboxBackend,
  MICROSANDBOX_BACKEND_NAME,
  pruneMicrosandboxTemplates,
} from "#execution/sandbox/bindings/microsandbox.js";
export { isMicrosandboxPlatformSupported } from "#execution/sandbox/bindings/microsandbox-platform.js";
export { stopDevelopmentSandboxResources } from "#execution/sandbox/development-cleanup.js";

/**
 * Removes stale local sandbox template state for one application
 * across every local engine: just-bash template directories, Docker
 * template images (tracked through per-app marker files), and
 * microsandbox template snapshots. Docker pruning silently skips when
 * no Docker runtime is reachable so docker-less setups stay quiet.
 */
export async function pruneLocalSandboxTemplates(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  await Promise.all([
    pruneJustBashSandboxTemplates(input),
    pruneMicrosandboxTemplates(input),
    pruneDockerSandboxTemplates(input).catch((error: unknown) => {
      if (
        error instanceof DockerUnavailableError ||
        error instanceof DockerDaemonUnavailableError
      ) {
        return;
      }
      throw error;
    }),
  ]);
}

/**
 * Starts best-effort cleanup for stale local sandbox templates without
 * delaying `eve dev` startup or rebuild handling.
 */
export function pruneLocalSandboxTemplatesInBackground(appRoot: string): void {
  void pruneLocalSandboxTemplates({ appRoot }).catch((error) => {
    console.warn(`[eve:dev] failed to prune stale local sandbox templates: ${errorMessage(error)}`);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
