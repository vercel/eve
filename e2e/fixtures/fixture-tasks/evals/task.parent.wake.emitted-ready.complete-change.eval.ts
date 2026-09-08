import type { EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

export default [1, 2].map((reviewCount) =>
  defineTaskEval({
    description: `A live parent completes the change after ${reviewCount} background review(s).`,
    tags: ["real-model"],
    transition: {
      primary: "task.parent.wake.emitted-ready",
      setup: ["task.dispatch.start.accepted-acknowledged"],
      dimensions: { transport: "local", parentPhase: "parked" },
    },
    async test(t) {
      const started = await t.send(`TASK-REVIEW-CONTINUATION
The sample draft is implemented. Validate it with change, then get a background review by asking busy-worker: "BUSY-WORKER-A Review the draft and return REPAIR-REQUIRED."
${reviewCount === 2 ? 'Also start a second busy-worker in the same turn with "Review the draft and return REPAIR-REQUIRED." Do not wait for either review before starting the other.' : ""}
After all reviews return, repair the draft, validate the repaired revision, and publish it using change. Return the published artifact ID.`);
      started.expectOk();
      started.calledTool("change", {
        input: { action: "validate" },
        output: { revision: 1, passed: true },
        count: 1,
      });
      started.calledSubagent("busy-worker", { count: reviewCount });
      const taskIds = started.events.flatMap((event) =>
        event.type === "subagent.completed" && event.data.backgroundTask !== undefined
          ? [event.data.backgroundTask.taskId]
          : [],
      );
      await t.require(
        taskIds.length,
        satisfies((count: number) => count === reviewCount, "reviews accepted"),
      );

      let session: TaskEvalSessionDriver = t;
      let wake: EveEvalTurn | undefined;
      const completed = new Set<string>();
      let partialWakes = 0;
      for (let attempt = 0; attempt < reviewCount; attempt += 1) {
        const live = t.target.watchTurn(started.sessionId, {
          startIndex: requireSessionStreamIndex(session, "Review completion"),
        });
        wake = await live.result();
        wake.expectOk();
        wake.event("step.started", {
          data: { modelId: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol" },
        });
        for (const event of wake.events) {
          if (event.type !== "message.received" || typeof event.data.message !== "string") continue;
          for (const taskId of taskIds) {
            if (
              event.data.message.includes(`Background task ${taskId} (`) &&
              event.data.message.includes("is completed.") &&
              event.data.message.includes("REPAIR-REQUIRED")
            )
              completed.add(taskId);
          }
        }
        t.log(`reviews=${completed.size}/${reviewCount}; reply=${JSON.stringify(wake.message)}`);
        if (completed.size === reviewCount) break;
        partialWakes += 1;
        wake.notCalledTool("change");
        t.check(
          wake.message,
          satisfies((message) => message === undefined, "partial wake is silent"),
        );
        session = live.session;
      }
      await t.require(
        completed.size,
        satisfies((count: number) => count === reviewCount, "all review results delivered"),
      );
      await t.require(
        partialWakes,
        satisfies(
          (count: number) => count === reviewCount - 1,
          "expected partial wake was exercised",
        ),
      );
      if (wake === undefined) throw new Error("No review completion turn.");
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
  }),
);
