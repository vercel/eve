import { randomUUID } from "node:crypto";

import type { SandboxBackendTags } from "#shared/sandbox-backend.js";

export const EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV = "EVE_DEVELOPMENT_SANDBOX_RUN_ID";
export const EVE_DEVELOPMENT_SANDBOX_METADATA_PATH_TAG = "eve.metadataPath";
export const EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG = "devRunId";

const initializedBackendsByRunId = new Map<string, Set<string>>();

export function createDevelopmentSandboxRunId(): string {
  return randomUUID();
}

export function getDevelopmentSandboxRunId(): string | undefined {
  const value = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function withDevelopmentSandboxTags(
  tags: SandboxBackendTags | undefined,
): SandboxBackendTags | undefined {
  const runId = getDevelopmentSandboxRunId();
  if (runId === undefined) {
    return tags;
  }
  return {
    ...tags,
    [EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG]: runId,
  };
}

export function withDevelopmentSandboxMetadataPathTag(
  tags: SandboxBackendTags | undefined,
  metadataPath: string,
): SandboxBackendTags | undefined {
  if (getDevelopmentSandboxRunId() === undefined) {
    return tags;
  }
  return {
    ...tags,
    [EVE_DEVELOPMENT_SANDBOX_METADATA_PATH_TAG]: metadataPath,
  };
}

export function markDevelopmentSandboxBackendInitialized(backendName: string): void {
  const runId = getDevelopmentSandboxRunId();
  if (runId === undefined) {
    return;
  }

  let initializedBackends = initializedBackendsByRunId.get(runId);
  if (initializedBackends === undefined) {
    initializedBackends = new Set();
    initializedBackendsByRunId.set(runId, initializedBackends);
  }
  initializedBackends.add(backendName);
}

export function getInitializedDevelopmentSandboxBackendNames(runId: string): readonly string[] {
  return [...(initializedBackendsByRunId.get(runId) ?? [])];
}

export function clearInitializedDevelopmentSandboxBackendNames(runId: string): void {
  initializedBackendsByRunId.delete(runId);
}
