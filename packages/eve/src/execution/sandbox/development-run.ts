import { randomUUID } from "node:crypto";

export const EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV = "EVE_DEVELOPMENT_SANDBOX_RUN_ID";
export const EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG = "devRunId";

export function createDevelopmentSandboxRunId(): string {
  return randomUUID();
}

export function getDevelopmentSandboxRunId(): string | undefined {
  const value = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function withDevelopmentSandboxTags(
  tags: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  const runId = getDevelopmentSandboxRunId();
  if (runId === undefined) {
    return tags;
  }
  return {
    ...tags,
    [EVE_DEVELOPMENT_SANDBOX_RUN_ID_TAG]: runId,
  };
}
