import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { detachedTaskIds, taskResultDeliveries } from "./helpers";

/**
 * A deploy waits on Alice's approval when Bob asks an unrelated question.
 * The question does not answer the approval, so the deploy moves to the
 * background and Bob gets a reply. When Alice approves later, the deploy
 * finishes and a result turn reports it.
 */
export default defineEval({
  description:
    "An unrelated message detaches a call waiting on an approval, and the answer is reported later.",
  timeoutMs: 180_000,
  async test(t) {
    const parked = await t.send("Alice is ready to ship the billing service. BG-APPROVAL-START");
    const session = parked.session;
    const request = session.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "confirm_deploy",
    });

    const parkedAt = session.state.streamIndex;
    const detached = await session.send("Bob here: what time is the retro today? BG-PING", {
      turnPolicy: "steer",
    });
    detached.expectOk();
    detached.messageIncludes("BG-PING-REPLY");
    // `task.detached` belongs to the deploy's turn, not to Bob's message.
    const continued = await t.target.watchTurn(parked.sessionId, { startIndex: parkedAt }).result();
    continued.messageIncludes("BG-PING-REPLY");
    const [taskId] = await t.require(
      detachedTaskIds(continued.events, "steer"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the deploy waiting on the approval moved to the background",
      ),
    );

    const reported = await session.respond([{ optionId: "approve", requestId: request.requestId }]);
    reported.expectOk();
    reported.messageIncludes("BG-RESULT");
    reported.messageIncludes(/"approved": ?true/u);
    t.check(
      taskResultDeliveries(reported.events),
      satisfies(
        (deliveries: readonly (readonly string[])[]) =>
          deliveries.length === 1 && deliveries[0]?.join() === taskId,
        "the approved deploy reports in one task.result message",
      ),
    );
  },
});
