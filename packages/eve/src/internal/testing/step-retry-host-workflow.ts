import { processApp } from "#runtime/app.js";
import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { isRetriedStep } from "#execution/hosts.js";

async function reportRetry(): Promise<{ readonly attempt: number; readonly retried: boolean }> {
  "use step";
  const { attempt } = getStepMetadata();
  if (attempt === 1) throw new Error("Transient failure on the first attempt");
  return { attempt, retried: isRetriedStep(processApp().hosts) };
}

export async function stepRetryHostWorkflow(): Promise<{
  readonly attempt: number;
  readonly retried: boolean;
}> {
  "use workflow";
  return await reportRetry();
}
