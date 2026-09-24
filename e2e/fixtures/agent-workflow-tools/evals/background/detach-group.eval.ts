import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskResultDeliveries, startedTaskIds, waitForStarts, watchNextTurn } from "./helpers";

/**
 * Alice asks for two slow status lookups. While the turn waits on them, Bob
 * posts a note. The note moves both lookups to the background as one group:
 * the turn answers Bob at once, and both lookups later report together in
 * one result turn.
 */
export default defineEval({
  description:
    "A steering message detaches the waited calls, and the group's results arrive in one turn.",
  timeoutMs: 180_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      "Alice would like the billing and search status before stand-up. BG-GROUP-START",
    );
    await waitForStarts(t, live, "slow_lookup", 2);

    const note = await live.session.start("Bob here: the stand-up moved to 10:15. BG-PING", {
      turnPolicy: "steer",
    });
    const shared = await live.result();
    await note.result();
    shared.expectOk();
    shared.event("task.detached", { count: 2, data: { reason: "steer" } });
    shared.messageIncludes("BG-PING-REPLY");
    shared.notEvent("message.received", { data: { kind: "task.result" } });

    const result = await watchNextTurn(t, shared);
    result.expectOk();
    result.messageIncludes("BG-RESULT");
    result.messageIncludes('"topic": "billing"');
    result.messageIncludes('"topic": "search"');
    const lookups = startedTaskIds(shared.events, "slow_lookup");
    t.check(
      taskResultDeliveries(result.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 &&
          deliveries[0]!.length === 2 &&
          lookups.every((taskId) => deliveries[0]!.includes(taskId)),
        "both lookups arrive together in one task.result message",
      ),
    );
    t.noFailedActions();
  },
});
