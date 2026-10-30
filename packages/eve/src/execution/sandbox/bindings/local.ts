/**
 * Facade over every local sandbox provider (Docker, just-bash) plus their
 * availability probes and cache pruning.
 *
 * This module is the single import path for local-engine functionality
 * from the public surface, so the hosted (Vercel) server bundle can
 * prune all of it by stubbing one module — see
 * `createCompiledSandboxProviderPrunePlugin`. Anything exported here
 * must also exist on that stub.
 */
import {
  DockerDaemonUnavailableError,
  DockerUnavailableError,
} from "#execution/sandbox/bindings/docker-cli.js";
import { pruneDockerSandboxTemplates } from "#execution/sandbox/bindings/docker.js";
import { pruneJustBashSandboxTemplates } from "#execution/sandbox/bindings/just-bash.js";

export {
  createDockerSandboxProvider,
  DOCKER_PROVIDER_NAME,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker.js";
export { isLinuxDockerDaemonAvailableSync } from "#execution/sandbox/bindings/docker-cli.js";
export {
  createJustBashSandboxProvider,
  JUST_BASH_PROVIDER_NAME,
  pruneJustBashSandboxTemplates,
} from "#execution/sandbox/bindings/just-bash.js";
export { stopDevelopmentSandboxResources } from "#execution/sandbox/development-cleanup.js";

/**
 * Removes stale local sandbox template state for one application
 * across every local engine: just-bash template directories and Docker
 * template images (tracked through per-app marker files). Docker pruning
 * silently skips when no Docker runtime is reachable so docker-less setups
 * stay quiet.
 */
export async function pruneLocalSandboxTemplates(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  await Promise.all([
    pruneJustBashSandboxTemplates(input),
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
    console.warn(`[eve:sandbox] failed to prune stale local templates: ${errorMessage(error)}`);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
