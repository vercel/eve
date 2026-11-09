import { afterEach, expect, it, vi } from "vitest";
import { trace } from "#compiled/@opentelemetry/api/index.js";
import { traceSessionHandover } from "#execution/session/handover-tracing.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "successor-run" }),
  getStepMetadata: () => ({ stepId: "turn-step", attempt: 1 }),
}));

afterEach(() => vi.restoreAllMocks());

it("exports the recorded receiver clock separately from the host observation", () => {
  const span = Object.assign(
    trace.wrapSpanContext({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
    { setAttribute: vi.fn(), addEvent: vi.fn() },
  );
  vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);
  const fields = {
    "eve.handoff.buffered_payload_count": 2,
    "eve.handoff.applied_at_ms": 123456,
    "eve.handoff.applied_at_clock": "workflow",
  };
  traceSessionHandover("inbox_unblocked", "session-1", "source-run:0", fields);
  expect(span.addEvent).toHaveBeenCalledExactlyOnceWith("eve.session.handover.inbox_unblocked", {
    "eve.session.id": "session-1",
    "eve.handoff.attempt_key": "source-run:0",
    "workflow.run.id": "successor-run",
    "workflow.step.id": "turn-step",
    "eve.handoff.step_attempt": 1,
    ...fields,
  });
  expect(span.setAttribute).toHaveBeenCalledWith("eve.handoff.attempt_key", "source-run:0");
  expect(span.setAttribute).toHaveBeenCalledWith("eve.handoff.applied_at_clock", "workflow");
});
