import { defineEval, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds, taskResultDeliveries, taskStarts, watchTurnsUntil } from "./helpers";

const REQUEST = [
  "Hi, this is Alice from the product team.",
  "Please ask the launch-writer to draft the launch announcement for the Orbit Notebook.",
  "No rush, share it here when it is ready.",
].join(" ");
const FOLLOW_UP = [
  "One more thing for the launch announcement you already asked for:",
  "it should mention that the Orbit Notebook costs $49 per team each month.",
].join(" ");

/**
 * A follow-up about work already in progress goes to the working agent
 * through its taskId: no second writer starts, and a draft that includes the
 * follow-up arrives. The writer's slow tool keeps it working when the
 * follow-up lands; if it still answers first, eve runs the follow-up as the
 * same agent's next detached work, and one more result arrives for it.
 */
export default defineEval({
  description: "A follow-up for a working agent is sent to it instead of starting new work.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const first = await t.send(REQUEST);
    first.expectOk();
    const [taskId] = await t.require(
      receiptTaskIds(first, "launch-writer"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "one launch-writer call that returned a receipt",
      ),
    );

    const followUp = await first.session.send(FOLLOW_UP);
    followUp.expectOk();
    followUp.calledTool("launch-writer", { count: 1, input: { taskId } });
    t.judge(
      "The assistant tells Alice briefly that the price was passed on for the draft in progress. It does not present a draft or start a separate one.",
      { on: followUp.message ?? "" },
    ).gate(0.7);

    const eventsWith = (turns: readonly EveEvalTurn[]) => [
      ...first.events,
      ...followUp.events,
      ...turns.flatMap((turn) => turn.events),
    ];
    // Watch until every piece of the writer's work has reported.
    const later = await watchTurnsUntil(
      t,
      followUp,
      (watched) =>
        taskResultDeliveries(eventsWith(watched)).flat().length >=
        taskStarts(eventsWith(watched), "launch-writer").length,
      2,
    );
    const result = later.at(-1)!;
    result.expectOk();
    result.messageIncludes(/\$49/);

    const events = eventsWith(later);
    const starts = taskStarts(events, "launch-writer");
    t.check(
      starts,
      satisfies(
        (calls: typeof starts) =>
          calls.length >= 1 && calls.length <= 2 && calls.every((call) => call.taskId === taskId),
        "the follow-up goes to the working writer; no second writer starts",
      ),
    );
    t.check(
      taskResultDeliveries(events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.flat().length === starts.length &&
          deliveries.flat().every((delivered) => delivered === taskId),
        "exactly one result arrives for each piece of the writer's work",
      ),
    );
    for (const turn of later) turn.noFailedActions();
  },
});
