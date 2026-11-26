import { getStepMetadata, RetryableError, type StepMetadata } from "#public/workflow/index.js";

const firstAttempts = ((globalThis as { [key: symbol]: unknown })[
  Symbol.for("eve.test.step-metadata.first-attempts")
] ??= new Map<string, StepMetadata>()) as Map<string, StepMetadata>;

async function readStepMetadata(): Promise<readonly StepMetadata[]> {
  "use step";
  const { stepId, attempt, maxAttempts } = getStepMetadata();
  if (attempt === 1) {
    firstAttempts.set(stepId, { stepId, attempt, maxAttempts });
    throw new RetryableError("Transient failure on the first attempt", { retryAfter: 1 });
  }
  const first = firstAttempts.get(stepId);
  firstAttempts.delete(stepId);
  return first === undefined
    ? [{ stepId, attempt, maxAttempts }]
    : [first, { stepId, attempt, maxAttempts }];
}
readStepMetadata.maxRetries = 2;

export async function stepMetadataWorkflow(): Promise<readonly StepMetadata[]> {
  "use workflow";
  return await readStepMetadata();
}
