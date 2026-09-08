import { satisfies } from "eve/evals/expect";

import { requireSessionStreamIndex } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

export default defineTaskEval({
  description: "A live parent repairs, revalidates, and publishes after a background review.",
  tags: ["real-model"],
  transition: {
    primary: "task.parent.wake.emitted-ready",
    setup: ["task.dispatch.start.accepted-acknowledged"],
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const started = await t.send(`TASK-REVIEW-CONTINUATION
The sample draft is implemented. Validate it with change, then get a background review by asking busy-worker: "BUSY-WORKER-A Review the draft and return REPAIR-REQUIRED."
After the review returns, repair the draft, validate the repaired revision, and publish it using change. Return the published artifact ID.`);
    started.expectOk();
    started.calledTool("change", {
      input: { action: "validate" },
      output: { revision: 1, passed: true },
      count: 1,
    });
    started.calledSubagent("busy-worker", { count: 1 });
    const taskIds = started.events.flatMap((event) =>
      event.type === "subagent.completed" && event.data.backgroundTask !== undefined
        ? [event.data.backgroundTask.taskId]
        : [],
    );
    await t.require(
      taskIds.length,
      satisfies((count: number) => count === 1, "review accepted"),
    );

    const live = t.target.watchTurn(started.sessionId, {
      startIndex: requireSessionStreamIndex(t, "Review completion"),
    });
    const wake = await live.result();
    wake.expectOk();
    wake.event("step.started", {
      data: { modelId: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol" },
    });
    wake.event("message.received", {
      data: (data) =>
        typeof data.message === "string" &&
        data.message.includes(`Background task ${taskIds[0]} (`) &&
        data.message.includes("is completed.") &&
        data.message.includes("REPAIR-REQUIRED"),
    });
    wake.calledTool("change", {
      input: { action: "repair" },
      output: { revision: 2 },
      count: 1,
    });
    wake.calledTool("change", {
      input: { action: "validate" },
      output: { revision: 2, passed: true },
      count: 1,
    });
    wake.calledTool("change", {
      input: { action: "publish" },
      output: { revision: 2, artifactId: "draft-2" },
      count: 1,
    });
    wake.messageIncludes("draft-2");
    t.noFailedActions();
  },
});
