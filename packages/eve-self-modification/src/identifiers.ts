import {
  assertFullGitSha,
  assertGitRef as assertRef,
  assertRepositoryPart as assertPart,
} from "./git.js";

export function assertFullSha(value: string, label: string): void {
  try {
    assertFullGitSha(value.toLowerCase(), `SelfModification ${label}`);
  } catch {
    throw new Error(`SelfModification ${label} must be a full Git SHA.`);
  }
}

export function assertRepositoryPart(value: string, label: string): void {
  try {
    assertPart(value, `SelfModification ${label}`);
  } catch {
    throw new Error(`SelfModification ${label} is invalid.`);
  }
}

export function assertGitRef(value: string, label = "pull request base"): void {
  try {
    assertRef(value, `SelfModification ${label}`);
  } catch {
    throw new Error(`SelfModification ${label} is not a valid Git ref.`);
  }
}

export function assertOperationId(operationId: string): void {
  if (operationId.length === 0 || operationId.length > 512) {
    throw new Error("Self-modification operation id must contain 1–512 characters.");
  }
}
