import type { TurnPosition } from "#harness/session-machine/view.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import type { RuntimeTraceContext } from "#protocol/message.js";

/** Prepares native tracing for workflow-owned preambles emitted outside the tool loop. */
export async function prepareWorkflowPreambleTrace(input: {
  readonly emissionState: TurnPosition;
  readonly instrumentation: ExecutionInstrumentation | undefined;
}): Promise<RuntimeTraceContext | undefined> {
  return await input.instrumentation?.preparePreamble({
    sequence: input.emissionState.sequence,
    sessionStarted: input.emissionState.sessionStarted,
    turnId: `turn_${input.emissionState.sequence}`,
  });
}
