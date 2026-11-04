import { trace, type Attributes } from "#compiled/@opentelemetry/api/index.js";
import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

/** Called only from existing host steps; workflow bodies cannot export host spans. */
export function traceSessionHandover(
  phase: "forwarding_started" | "part_submitted" | "final_submitted" | "inbox_unblocked",
  sessionId: string,
  attemptKey: string,
  attributes: Attributes,
): void {
  try {
    const span = trace.getActiveSpan();
    if (span === undefined) return;
    const step = getStepMetadata();
    const fields = {
      "eve.session.id": sessionId,
      "eve.handoff.attempt_key": attemptKey,
      "workflow.run.id": getWorkflowMetadata().workflowRunId,
      "workflow.step.id": step.stepId,
      "eve.handoff.step_attempt": step.attempt,
      ...attributes,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    span.addEvent(`eve.session.handover.${phase}`, fields);
  } catch {
    // A tracing failure must not retry a message delivery or fail a turn.
  }
}
