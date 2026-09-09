import { defineEval, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import {
  completeReport,
  QUESTION,
  sendQuestion,
  startWarehouseLookups,
  TASK_COUNT,
  waitForPartialCompletion,
  waitForReport,
} from "./reporting.js";

function pendingResponseEval() {
  return defineEval({
    description:
      "After a partial completion, the parent answers a user while sibling tasks are running, then reports all results.",
    tags: ["real-model", "pending-response"],
    async test(t) {
      const run = await startWarehouseLookups(t);
      await waitForPartialCompletion(t, run);

      const question = await sendQuestion(t, run);
      question.messageIncludes(/\b56\b/u);
      question.usedNoTools();

      const report = await waitForReport(t, run);
      t.check(report, completeReport());
      t.notEvent("compaction.requested");

      await t.require(
        run.childSessionIds.size,
        satisfies(
          (count) => count === TASK_COUNT,
          "all child sessions are available for timing checks",
        ),
      );
      const children = await Promise.all(
        [...run.childSessionIds].map((sessionId) => t.target.watchTurn(sessionId).result()),
      );
      const settledAt = Math.max(...children.map(completedAt));
      const received = question.events.find(
        (event) => event.type === "message.received" && event.data.message.includes(QUESTION),
      );
      const answered = question.events.find(
        (event) =>
          event.type === "message.completed" &&
          event.data.finishReason !== "tool-calls" &&
          /\b56\b/u.test(event.data.message ?? ""),
      );
      const askedAt = Date.parse(received?.meta.at ?? "");
      const answeredAt = Date.parse(answered?.meta.at ?? "");
      t.check(
        askedAt < settledAt,
        satisfies(Boolean, "the user question reached the parent before cohort settlement"),
      );
      t.check(
        answeredAt < settledAt,
        satisfies(Boolean, "the user received an answer before cohort settlement"),
      );
      t.log(
        `user reply=${JSON.stringify(question.message)} asked=${askedAt} answered=${answeredAt} settled=${settledAt}`,
      );
      t.noFailedActions();
    },
  });
}

export default Array.from({ length: 20 }, pendingResponseEval);

function completedAt(turn: EveEvalTurn): number {
  const event = turn.events.find((entry) => entry.type === "turn.completed");
  if (event === undefined) throw new Error("Missing child completion event for timing check.");
  return Date.parse(event.meta.at);
}
