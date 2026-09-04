import { isFullGitSha, isValidGitRef } from "#shared/git.js";

export function assertFullSha(value: string, label: string): void {
  if (!isFullGitSha(value)) {
    throw new Error(`Self-modification ${label} must be a full Git SHA.`);
  }
}

export function assertRepositoryPart(value: string, label: string): void {
  if (
    !/^[A-Za-z0-9_.-]+$/u.test(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("-")
  ) {
    throw new Error(`Self-modification ${label} is invalid.`);
  }
}

export function assertGitRef(value: string, label = "target branch"): void {
  if (!isValidGitRef(value)) {
    throw new Error(`Self-modification ${label} is not a valid Git ref.`);
  }
}

export function assertOperationId(operationId: string): void {
  if (operationId.length === 0 || operationId.length > 512) {
    throw new Error("Self-modification operation id must contain 1–512 characters.");
  }
}
