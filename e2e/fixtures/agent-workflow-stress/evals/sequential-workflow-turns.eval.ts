import { defineEval, type EveEvalSession } from "eve/evals";
import { equals } from "eve/evals/expect";

const TURN_COUNT = 100;
const PERFORMANCE_LOG_PREFIX = "EVE_WORKFLOW_STRESS_METRIC=";

export default defineEval({
  description: "Workflow stress: one durable session completes 100 sequential turns.",
  tags: ["stress", "workflow", "sequential"],

  async test(t) {
    let session: EveEvalSession | undefined;
    const samples: Array<{ durationMs: number; turnNumber: number }> = [];

    for (let turnNumber = 1; turnNumber <= TURN_COUNT; turnNumber += 1) {
      const marker = `sequential-turn-${String(turnNumber).padStart(3, "0")}`;
      const startedAt = performance.now();
      const result = await (session === undefined ? t.send(marker) : session.send(marker));
      const durationMs = performance.now() - startedAt;
      const elapsedSeconds = durationMs / 1_000;

      samples.push({ durationMs, turnNumber });

      t.log(
        `turn ${String(turnNumber).padStart(3, "0")}/${TURN_COUNT} completed in ${elapsedSeconds.toFixed(3)}s`,
      );

      session ??= result.session;

      const turn = result.expectOk();

      await t.require(turn.sessionId, equals(session.sessionId));
      await t.require(turn.message, equals(`stress-ack:${turnNumber}:${marker}`));
    }

    t.log(
      `${PERFORMANCE_LOG_PREFIX}${JSON.stringify({
        fixture: "agent-workflow-stress",
        scenario: "sequential",
        schemaVersion: 1,
        sessionId: session?.sessionId,
        samples,
        unit: "milliseconds",
      })}`,
    );

    t.succeeded();
    t.event("session.started", { count: 1 });
    t.event("turn.started", { count: TURN_COUNT });
    t.event("turn.completed", { count: TURN_COUNT });
    t.notEvent("turn.failed");
  },
});
