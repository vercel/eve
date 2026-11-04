import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { isRetriedStep } from "#execution/hosts.js";

/**
 * Fails its first attempt, then reports what eve's step code reads on the retry: a retried step
 * repairs what its interrupted attempt wrote only when it knows it's a retry.
 */
async function reportRetry(): Promise<{ readonly attempt: number; readonly retried: boolean }> {
  "use step";
  const { attempt } = getStepMetadata();
  if (attempt === 1) throw new Error("Transient failure on the first attempt");
  return { attempt, retried: isRetriedStep() };
}

/** One step that Workflow retries once. */
export async function stepRetryHostWorkflow(): Promise<{
  readonly attempt: number;
  readonly retried: boolean;
}> {
  "use workflow";
  return await reportRetry();
}
