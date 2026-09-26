import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { assistantMessages, reportIdOf, settlementsOf, taskStarts } from "./task-events";

/** The expansion of QBR, however the model formats it. */
const QBR_EXPANSION = /business\W+review/iu;

/**
 * Right after the churn report task starts, Alice asks an unrelated question.
 * It arrives as steering during the model's next step, before any wait. The
 * model answers it, keeps the report running, and still delivers its id.
 */
export default defineEval({
  description: "The model keeps its tasks after an unrelated message.",
  tags: ["real-model"],
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      "Please compile the churn report for Alice and tell me its report id when it's ready.",
    );
    await live.waitForEvent("task.started", { data: { name: "compile_report" } });

    const question = await live.session.start(
      "While that compiles, a quick unrelated question from Alice: what does QBR usually stand for?",
      { turnPolicy: "steer" },
    );
    const turn = await live.result();
    const answered = await question.result();
    turn.expectOk();

    turn.notCalledTool("task_cancel");
    const started = taskStarts(turn.events, "compile_report");
    t.check(started.length, equals(1)).label("the report is compiled once");
    const settled = settlementsOf(
      turn.events,
      started.map((call) => call.callId),
    );
    t.check(
      settled.map((settlement) => settlement.status),
      equals(["completed"]),
    ).label("the report task completes");
    const reportIds = settled.flatMap((settlement) => reportIdOf(settlement) ?? []);
    t.check(
      turn.message,
      satisfies(
        (reply: string | undefined) =>
          reportIds.length === 1 && reply?.includes(reportIds[0]!) === true,
        "the final reply names the report id",
      ),
    );
    // The answer may come in an interim message or the final reply.
    t.check(
      [...assistantMessages(turn.events), ...assistantMessages(answered.events)],
      satisfies(
        (messages: readonly string[]) => messages.some((message) => QBR_EXPANSION.test(message)),
        "Alice's unrelated question gets an answer",
      ),
    );
    t.noFailedActions();
  },
});
