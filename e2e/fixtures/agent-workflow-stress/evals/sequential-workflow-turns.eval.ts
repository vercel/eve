import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const TURN_COUNT = 100;

export default defineEval({
  description: "Workflow stress: one durable session completes 100 sequential turns.",
  tags: ["stress", "workflow", "sequential"],

  async test(t) {
    let sessionId: string | undefined;

    for (let turnNumber = 1; turnNumber <= TURN_COUNT; turnNumber += 1) {
      const marker = `sequential-turn-${String(turnNumber).padStart(3, "0")}`;
      const startedAt = performance.now();
      const result = await t.send(marker);
      const elapsedSeconds = (performance.now() - startedAt) / 1_000;

      t.log(
        `turn ${String(turnNumber).padStart(3, "0")}/${TURN_COUNT} completed in ${elapsedSeconds.toFixed(3)}s`,
      );

      const turn = result.expectOk();

      sessionId ??= turn.sessionId;
      await t.require(turn.sessionId, equals(sessionId));
      await t.require(turn.message, equals(`stress-ack:${turnNumber}:${marker}`));
    }

    t.succeeded();
    t.event("session.started", { count: 1 });
    t.event("turn.started", { count: TURN_COUNT });
    t.event("turn.completed", { count: TURN_COUNT });
    t.notEvent("turn.failed");
  },
});
