import { activeTurnId } from "#harness/active-turn-id.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import type { RuntimeTraceContext } from "#protocol/message.js";

/** Prepares native tracing for workflow-owned preambles emitted outside the tool loop. */
export async function prepareWorkflowPreambleTrace(input: {
  readonly emissionState: HarnessEmissionState;
  readonly instrumentation: ExecutionInstrumentation | undefined;
}): Promise<RuntimeTraceContext | undefined> {
  return await input.instrumentation?.preparePreamble({
    sequence: input.emissionState.sequence,
    sessionStarted: input.emissionState.sessionStarted,
    turnId: activeTurnId(input.emissionState),
  });
}
