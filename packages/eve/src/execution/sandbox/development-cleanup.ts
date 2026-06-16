import { randomUUID } from "node:crypto";

import {
  DOCKER_SANDBOX_LABEL,
  stopDockerContainerIfRunning,
} from "#execution/sandbox/bindings/docker-container.js";
import { DOCKER_BACKEND_NAME } from "#execution/sandbox/bindings/docker.js";
import { createDockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import {
  MICROSANDBOX_METADATA_VERSION,
  readSessionMetadata,
  writeSessionMetadata,
} from "#execution/sandbox/bindings/microsandbox-metadata.js";
import {
  createProviderName,
  loadMicrosandboxWithoutInstall,
  removeSnapshotIfExists,
  stopAndSnapshotMicrosandboxSandbox,
} from "#execution/sandbox/bindings/microsandbox-runtime.js";
import { MICROSANDBOX_BACKEND_NAME } from "#execution/sandbox/bindings/microsandbox.js";
import {
  EVE_DEVELOPMENT_SANDBOX_METADATA_PATH_TAG,
  EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG,
} from "#execution/sandbox/development-run.js";
import { toErrorMessage } from "#shared/errors.js";

export async function stopDevelopmentSandboxResources(input: {
  readonly backendNames?: readonly string[];
  readonly devRunId: string;
  readonly log?: (message: string) => void;
}): Promise<void> {
  const backendNames = input.backendNames === undefined ? null : new Set(input.backendNames);
  const cleanupTasks: Promise<void>[] = [];

  if (backendNames === null || backendNames.has(DOCKER_BACKEND_NAME)) {
    cleanupTasks.push(stopDevelopmentDockerResources(input.devRunId));
  }

  if (backendNames === null || backendNames.has(MICROSANDBOX_BACKEND_NAME)) {
    cleanupTasks.push(stopDevelopmentMicrosandboxResources(input.devRunId, input.log));
  }

  const errors = await Promise.allSettled(cleanupTasks);

  for (const error of errors) {
    if (error.status === "rejected") {
      input.log?.(`failed to stop development sandbox resources: ${toErrorMessage(error.reason)}`);
    }
  }
}

async function stopDevelopmentDockerResources(devRunId: string): Promise<void> {
  const cli = createDockerCli();
  const labelFilters = [
    `label=${DOCKER_SANDBOX_LABEL}=1`,
    `label=${DOCKER_SANDBOX_LABEL}.tag.${EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG}=${devRunId}`,
  ];
  const running = await cli.run([
    "ps",
    "-q",
    ...labelFilters.flatMap((filter) => ["--filter", filter]),
  ]);
  if (running.exitCode !== 0) {
    return;
  }

  const containerIds = running.stdout.trim().split(/\s+/u).filter(Boolean);
  await Promise.all(
    containerIds.map((containerId) => stopDockerContainerIfRunning(cli, containerId)),
  );
}

async function stopDevelopmentMicrosandboxResources(
  devRunId: string,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const module = await loadMicrosandboxWithoutInstall();
  if (module === null) {
    return;
  }

  const sandboxes = await module.Sandbox.listWith({
    labels: {
      "eve.backend": "microsandbox",
      [EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG]: devRunId,
    },
  });

  await Promise.all(
    sandboxes
      .filter((sandbox) => sandbox.status === "running" || sandbox.status === "draining")
      .map(async (sandbox) => {
        const metadataPath = getMicrosandboxLabel(
          sandbox.configJson,
          EVE_DEVELOPMENT_SANDBOX_METADATA_PATH_TAG,
        );
        if (metadataPath === undefined) {
          const handle = await module.Sandbox.get(sandbox.name);
          await handle.stopWithTimeout(10_000).catch(() => {});
          return;
        }

        const metadata = await readSessionMetadata(metadataPath);
        if (metadata === null || metadata.sandboxName !== sandbox.name) {
          const handle = await module.Sandbox.get(sandbox.name);
          await handle.stopWithTimeout(10_000).catch(() => {});
          return;
        }

        log?.(`snapshotting development microsandbox session "${sandbox.name}" before shutdown`);
        const previousStateSnapshotName = metadata.stateSnapshotName;
        const stateSnapshotName = createProviderName(
          "eve-sbx-state",
          `${metadata.sandboxName}:${randomUUID()}`,
        );
        await stopAndSnapshotMicrosandboxSandbox(module, sandbox.name, stateSnapshotName);
        await writeSessionMetadata(metadataPath, {
          networkPolicy: metadata.networkPolicy,
          optionsHash: metadata.optionsHash,
          sandboxName: metadata.sandboxName,
          stateSnapshotName,
          version: MICROSANDBOX_METADATA_VERSION,
        });
        if (previousStateSnapshotName !== undefined) {
          await removeSnapshotIfExists(module, previousStateSnapshotName);
        }
      }),
  );
}

function getMicrosandboxLabel(configJson: string, key: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return undefined;
  }

  return findLabel(parsed, key);
}

function findLabel(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const direct = value[key];
  if (typeof direct === "string") {
    return direct;
  }

  const labels = value.labels;
  if (isRecord(labels) && typeof labels[key] === "string") {
    return labels[key];
  }

  if (typeof value.labelsJson === "string") {
    const parsedLabels = parseJsonRecord(value.labelsJson);
    if (parsedLabels !== null && typeof parsedLabels[key] === "string") {
      return parsedLabels[key];
    }
  }

  for (const child of Object.values(value)) {
    const found = findLabel(child, key);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
