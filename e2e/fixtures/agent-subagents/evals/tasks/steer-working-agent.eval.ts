import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskResultDeliveries, taskStarts } from "./helpers";

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
 * follow-up arrives in the same turn. Alice writes it while the turn holds on
 * the writer, whose slow tool keeps it working when the follow-up lands; if
 * it still answers first, eve runs the follow-up as the same agent's next
 * generation, and one more result arrives for it.
 */
export default defineEval({
  description: "A follow-up for a working agent is sent to it instead of starting new work.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(REQUEST);
    await live.waitForEvent("turn.completed", { data: { held: true } });
    // The writer reports its start through the parent's inbox, which can land
    // after the waiting boundary.
    const started = await live.waitForEvent("task.started", { data: { name: "launch-writer" } });
    await t.require(
      started.data,
      satisfies(
        (data: typeof started.data) => data.generation === 1,
        "the launch-writer task started with its first generation",
      ),
    );
    const taskId = started.data.taskId;

    const followUp = await conversation.send(FOLLOW_UP, { turnPolicy: "steer" });
    followUp.expectOk();
    followUp.calledTool("launch-writer", { count: 1, input: { taskId } });

    const turn = await live.result();
    turn.expectOk();
    turn.messageIncludes(/\$49/);
    const starts = taskStarts(turn.events, "launch-writer");
    t.check(
      starts,
      satisfies(
        (calls: typeof starts) =>
          calls.length >= 1 && calls.length <= 2 && calls.every((call) => call.taskId === taskId),
        "the follow-up goes to the working writer; no second writer starts",
      ),
    );
    t.check(
      taskResultDeliveries(turn.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.flat().length === starts.length &&
          deliveries.flat().every((delivered) => delivered === taskId),
        "exactly one result arrives for each piece of the writer's work",
      ),
    );
    turn.noFailedActions();
  },
});
