import { randomUUID } from "node:crypto";

import type { SandboxBackendTags } from "#shared/sandbox-backend.js";

export const EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV = "EVE_DEVELOPMENT_SANDBOX_RUN_ID";
export const EVE_DEVELOPMENT_SANDBOX_METADATA_PATH_TAG = "eve.metadataPath";
export const EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG = "devRunId";

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
