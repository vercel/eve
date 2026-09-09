import { defineEval, type Assertion, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { reportingControl, type PendingInstruction } from "../agent/lib/reporting-model.js";
import {
  completeReport,
  intermediateWakes,
  QUESTION,
  sendQuestion,
  silentWake,
  startWarehouseLookups,
  TASK_COUNT,
  waitForPartialCompletion,
  waitForReport,
} from "./reporting.js";

function pendingResponseEval(pendingInstruction: PendingInstruction, silence: Assertion) {
  return defineEval({
    description: `After an intermediate task wake, the parent answers a user before settlement, then reports all results (pending instruction ${pendingInstruction}).`,
    tags: ["real-model", "pending-response"],
    metadata: { pendingInstruction },
    async test(t) {
      const run = await startWarehouseLookups(t, reportingControl(pendingInstruction));
      await waitForPartialCompletion(t, run);

      const question = await sendQuestion(t, run);
      question.messageIncludes(/\b56\b/u);
      question.usedNoTools();
      t.log(
        `pending instruction ${pendingInstruction}: user reply=${JSON.stringify(question.message)}`,
      );

      const report = await waitForReport(t, run);
      for (const wake of intermediateWakes(run)) {
        t.check(wake.message, silence);
      }
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
        `pending instruction ${pendingInstruction}: asked=${askedAt} answered=${answeredAt} settled=${settledAt}`,
      );
      t.noFailedActions();
    },
  });
}

export default Array.from({ length: 20 }, () => [
  pendingResponseEval("on", silentWake()),
  pendingResponseEval("off", silentWake().soft(0)),
]).flat();

function completedAt(turn: EveEvalTurn): number {
  const event = turn.events.find((entry) => entry.type === "turn.completed");
  if (event === undefined) throw new Error("Missing child completion event for timing check.");
  return Date.parse(event.meta.at);
}
