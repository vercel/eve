import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds, taskResultDeliveries } from "./helpers";

/**
 * Alice needs two reminders together. Both start in one step, the model
 * waits on each with one task_wait in the next step, and the reply combines
 * both results in the same turn.
 */
export default defineEval({
  description: "Two tasks started in one step are waited on together, one task_wait each.",
  timeoutMs: 120_000,
  async test(t) {
    const turn = await t.send("Alice would like two reminders for today. TASKS-FANIN-START");
    turn.expectOk();
    await t.require(
      startedTaskIds(turn.events, "remind_later"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 2,
        "both reminders started as detached tasks",
      ),
    );

    turn.eventsSatisfy("both waits are requested in the same step", (events) =>
      events.some(
        (event) =>
          event.type === "actions.requested" &&
          event.data.actions.filter(
            (action) => "toolName" in action && action.toolName === "task_wait",
          ).length === 2,
      ),
    );
    turn.calledTool("task_wait", { count: 2, output: { status: "settled" } });
    turn.messageIncludes("Reminder: stand-up");
    turn.messageIncludes("Reminder: lunch");
    t.check(
      taskResultDeliveries(turn.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) => deliveries.length === 0,
        "each result reaches the model once, through its wait",
      ),
    );
    turn.event("task.ended", { count: 2 });
    // Both waits took their results, so the turn never held.
    turn.event("session.waiting", { count: 1 });
  },
});
