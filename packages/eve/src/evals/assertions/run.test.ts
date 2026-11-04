import { expect, it } from "vitest";
import { calledTool, toolOrder } from "#evals/assertions/run.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import { stampTestEvents, testTurnFacts } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";

it("orders task controls and agent calls consistently with named tool assertions, excluding skills", async () => {
  const requests = (
    [
      ["lookup", "tool"],
      ["guide", "skill"],
      ["eve__task_wait", "control"],
      ["worker", "agent"],
    ] as const
  ).map(([name, kind]): SessionEvent => ({
    type: "call.requested",
    scope: { turnId: "turn_0", runId: "run_0" },
    data: { callId: name, capability: { kind, name }, owner: { runId: "run_0" } },
  }));
  const events = stampTestEvents([
    ...testTurnFacts(0, "Starting.", ["initial"]).slice(0, 4),
    ...requests,
  ]);
  const subject = {
    derived: deriveRunFacts(events),
    events,
    output: undefined,
    status: "working" as const,
  };
  expect((await calledTool("eve__task_wait", { status: "pending" }).evaluate(subject)).score).toBe(
    1,
  );
  expect((await toolOrder(["lookup", "eve__task_wait", "worker"]).evaluate(subject)).score).toBe(1);
  expect((await toolOrder(["worker", "lookup"]).evaluate(subject)).score).toBe(0);
  expect((await toolOrder(["guide"]).evaluate(subject)).score).toBe(0);
});
