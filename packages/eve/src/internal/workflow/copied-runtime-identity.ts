import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolvePackageCompiledFilePath } from "#internal/application/package.js";

export interface WorkflowCopiedRuntimeIdentityV1 {
  readonly codecContract: "workflow-public-codec-v1";
  readonly emittedDigest: string;
  readonly inputDigest: string;
  readonly packageVersion: string;
  readonly version: 1;
}

const DIGEST = /^[a-f0-9]{64}$/u;

export function isWorkflowCopiedRuntimeIdentityV1(
  value: unknown,
): value is WorkflowCopiedRuntimeIdentityV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    (value as { codecContract?: unknown }).codecContract === "workflow-public-codec-v1" &&
    typeof (value as { packageVersion?: unknown }).packageVersion === "string" &&
    DIGEST.test(String((value as { inputDigest?: unknown }).inputDigest)) &&
    DIGEST.test(String((value as { emittedDigest?: unknown }).emittedDigest))
  );
}

export async function readWorkflowCopiedRuntimeIdentity(): Promise<
  WorkflowCopiedRuntimeIdentityV1 | undefined
> {
  try {
    const path = join(
      dirname(resolvePackageCompiledFilePath("src/compiled/@workflow/core/runtime.js")),
      ".eve-copied-runtime-identity.json",
    );
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isWorkflowCopiedRuntimeIdentityV1(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function workflowCopiedRuntimeIdentitiesMatch(
  a: WorkflowCopiedRuntimeIdentityV1 | undefined,
  b: WorkflowCopiedRuntimeIdentityV1 | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.codecContract === b.codecContract &&
    a.emittedDigest === b.emittedDigest &&
    a.inputDigest === b.inputDigest &&
    a.packageVersion === b.packageVersion
  );
}
