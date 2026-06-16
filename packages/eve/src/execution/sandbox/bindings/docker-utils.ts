import type { DockerCommandResult } from "#execution/sandbox/bindings/docker-cli.js";

export function expectDockerSuccess(result: DockerCommandResult, action: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Failed to ${action}: ${detail}`);
  }
}
