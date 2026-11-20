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

export function pruneLocalSandboxTemplatesInBackground(appRoot: string): void {
  void pruneLocalSandboxTemplates({ appRoot }).catch((error) => {
    console.warn(`[eve:sandbox] failed to prune stale local templates: ${errorMessage(error)}`);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
