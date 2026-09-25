import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  completedAt,
  modelSteps,
  QUESTION,
  sendQuestion,
  startWarehouseLookups,
  waitForPartialCompletion,
  waitForReport,
} from "./reporting.js";

function pendingResponseEval() {
  return defineEval({
    description:
      "A real parent answers Alice after one child completes while sibling approvals remain pending, then reports the whole cohort including a nested lookup.",
    tags: ["real-model", "pending-response"],
    async test(t) {
      const run = await startWarehouseLookups(t);
      await waitForPartialCompletion(t, run);
      const question = await sendQuestion(t, run);
      const report = await waitForReport(t, run);

      const first = run.completedChildren.get("first");
      const last = run.completedChildren.get("third");
      if (first === undefined || last === undefined)
        throw new Error("Missing completed warehouse children.");
      const received = question.events.find(
        (event) => event.type === "message.received" && event.data.message === QUESTION,
      );
      const answered = question.events.find(
        (event) => event.type === "message.completed" && event.data.message?.trim() === "56",
      );
      const reportStep = report.events.find((event) => event.type === "step.started");
      const askedAt = Date.parse(received?.meta.at ?? "");
      const answeredAt = Date.parse(answered?.meta.at ?? "");
      const reportAt = Date.parse(reportStep?.meta.at ?? "");
      t.check(completedAt(first) <= askedAt, equals(true)).label(
        "the user question follows actual child completion",
      );
      t.check(answeredAt < completedAt(last), equals(true)).label(
        "the user answer precedes the nested child's completion",
      );
      t.check(completedAt(last) <= reportAt, equals(true)).label(
        "the cohort model turn starts only after the last child completes",
      );
      t.check(modelSteps(run.parentTurns), equals(2)).label(
        "only the user answer and final cohort report invoke the parent model",
      );
      t.notEvent("compaction.requested");
      t.noFailedActions();
    },
  });
}

export default Array.from({ length: 20 }, pendingResponseEval);
