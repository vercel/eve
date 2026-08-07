import { defineEval } from "eve/evals";

import { requireBackgroundTaskId, waitForCompletedTask, waitForTaskInput } from "./shared.js";

/**
 * Task-owned child HITL must surface on the parent session, and answering it
 * must route to the child without running the parent model.
 */
export default defineEval({
  description:
    "A background child's approval surfaces on the parent and routes back without a parent model step.",
  async test(t) {
    const started = await t.send("TASK-HITL-ROUTING");
    started.expectOk();
    started.event("subagent.completed", {
      count: 1,
      data: { backgroundTask: { status: "working" }, subagentName: "approval-worker" },
    });
    const taskId = requireBackgroundTaskId(started);

    const first = await waitForTaskInput(t, t, "first_gate");
    const answered = await first.session.respond({
      optionId: "approve",
      requestId: first.request.requestId,
    });
    answered.expectOk();
    answered.notEvent("step.started");

    // A second child request proves the first answer reached the child even
    // though the parent model did not run.
    const second = await waitForTaskInput(t, first.session, "second_gate");
    const answeredSecond = await second.session.respond({
      optionId: "approve",
      requestId: second.request.requestId,
    });
    answeredSecond.expectOk();
    answeredSecond.notEvent("step.started");

    const third = await waitForTaskInput(t, second.session, "third_gate");
    const finished = await third.session.respond({
      optionId: "approve",
      requestId: third.request.requestId,
    });
    finished.expectOk();

    const verified = await waitForCompletedTask(t, third.session, "TASK-HITL-VERIFY", taskId);
    verified.expectOk();
    verified.messageIncludes("TASK-HITL-STATUS");

    t.event("input.requested", { data: { requests: [{ action: { toolName: "first_gate" } }] } });
    t.noFailedActions();
  },
});
