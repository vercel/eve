import {
  DOCKER_SANDBOX_LABEL,
  stopDockerContainerIfRunning,
} from "#execution/sandbox/bindings/docker-container.js";
import { createDockerCli, DockerUnavailableError } from "#execution/sandbox/bindings/docker-cli.js";
import { EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG } from "#execution/sandbox/development-run.js";
import { toErrorMessage } from "#shared/errors.js";

export async function stopDevelopmentSandboxResources(input: {
  readonly devRunId: string;
  readonly log?: (message: string) => void;
}): Promise<void> {
  try {
    await stopDevelopmentDockerResources(input.devRunId);
  } catch (error) {
    input.log?.(`failed to stop development sandbox resources: ${toErrorMessage(error)}`);
  }
}

async function stopDevelopmentDockerResources(devRunId: string): Promise<void> {
  const cli = createDockerCli();
  const labelFilters = [
    `label=${DOCKER_SANDBOX_LABEL}=1`,
    `label=${DOCKER_SANDBOX_LABEL}.tag.${EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG}=${devRunId}`,
  ];
  let running;
  try {
    running = await cli.run([
      "ps",
      "-q",
      ...labelFilters.flatMap((filter) => ["--filter", filter]),
    ]);
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return;
    }
    throw error;
  }
  if (running.exitCode !== 0) {
    return;
  }

  const containerIds = running.stdout.trim().split(/\s+/u).filter(Boolean);
  await Promise.all(
    containerIds.map((containerId) => stopDockerContainerIfRunning(cli, containerId)),
  );
}
