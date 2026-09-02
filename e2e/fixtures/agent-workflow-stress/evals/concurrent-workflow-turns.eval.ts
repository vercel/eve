import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const SESSION_COUNT = 50;
const TURNS_PER_SESSION = 2;
const TURN_COUNT = SESSION_COUNT * TURNS_PER_SESSION;
const PERFORMANCE_LOG_PREFIX = "EVE_WORKFLOW_STRESS_METRIC=";

export default defineEval({
  description: "Workflow stress: 50 durable sessions complete 100 total turns.",
  tags: ["stress", "workflow", "concurrent"],

  async test(t) {
    const sessions = Array.from({ length: SESSION_COUNT }, () => t.newSession());
    const firstBatchStartedAt = performance.now();
    const firstTurns = await Promise.all(
      sessions.map(async (session, index) => {
        const startedAt = performance.now();
        const result = await session.send(markerFor(index, 1));

        return {
          durationMs: performance.now() - startedAt,
          result,
          sessionNumber: index + 1,
        };
      }),
    );
    const firstBatchDurationMs = performance.now() - firstBatchStartedAt;
    firstTurns.forEach((turn, index) => {
      t.log(`workflow run id (${index + 1}/${SESSION_COUNT}): ${turn.result.sessionId}`);
    });
    const secondBatchStartedAt = performance.now();
    const secondTurns = await Promise.all(
      sessions.map(async (session, index) => {
        const startedAt = performance.now();
        const result = await session.send(markerFor(index, 2));

        return {
          durationMs: performance.now() - startedAt,
          result,
          sessionNumber: index + 1,
        };
      }),
    );
    const secondBatchDurationMs = performance.now() - secondBatchStartedAt;

    for (let index = 0; index < SESSION_COUNT; index += 1) {
      const first = firstTurns[index]!.result.expectOk();
      const second = secondTurns[index]!.result.expectOk();

      await t.require(first.message, equals(`stress-ack:1:${markerFor(index, 1)}`));
      await t.require(second.message, equals(`stress-ack:2:${markerFor(index, 2)}`));
      await t.require(second.sessionId, equals(first.sessionId));
    }

    await t.require(
      new Set(firstTurns.map((turn) => turn.result.sessionId)).size,
      equals(SESSION_COUNT),
    );

    t.log(
      `${PERFORMANCE_LOG_PREFIX}${JSON.stringify({
        batches: [
          {
            batchDurationMs: firstBatchDurationMs,
            samples: firstTurns.map(({ durationMs, sessionNumber }) => ({
              durationMs,
              sessionNumber,
            })),
            turnNumber: 1,
          },
          {
            batchDurationMs: secondBatchDurationMs,
            samples: secondTurns.map(({ durationMs, sessionNumber }) => ({
              durationMs,
              sessionNumber,
            })),
            turnNumber: 2,
          },
        ],
        fixture: "agent-workflow-stress",
        scenario: "concurrent",
        schemaVersion: 1,
        unit: "milliseconds",
      })}`,
    );

    t.succeeded();
    t.event("session.started", { count: SESSION_COUNT });
    t.event("turn.started", { count: TURN_COUNT });
    t.event("turn.completed", { count: TURN_COUNT });
    t.notEvent("turn.failed");
  },
});

function markerFor(sessionIndex: number, turnNumber: number): string {
  return `stress-session-${String(sessionIndex + 1).padStart(2, "0")}-turn-${turnNumber}`;
}
