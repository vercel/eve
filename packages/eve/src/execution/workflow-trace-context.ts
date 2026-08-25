import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionInstrumentation } from "#instrumentation/session-plan.js";
import type { RuntimeTraceContext } from "#protocol/message.js";

/** Prepares native tracing for workflow-owned preambles emitted outside the tool loop. */
export async function prepareWorkflowPreambleTrace(input: {
  readonly emissionState: HarnessEmissionState;
  readonly instrumentation: SessionInstrumentation;
  readonly session: HarnessSession;
}): Promise<RuntimeTraceContext | undefined> {
  return await input.instrumentation.preparePreamble({
    sequence: input.emissionState.sequence,
    sessionId: input.session.sessionId,
    sessionStarted: input.emissionState.sessionStarted,
    turnId: `turn_${input.emissionState.sequence}`,
  });
}
