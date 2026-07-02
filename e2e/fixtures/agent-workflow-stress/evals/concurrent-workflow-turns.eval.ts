import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const SESSION_COUNT = 50;
const TURNS_PER_SESSION = 2;
const TURN_COUNT = SESSION_COUNT * TURNS_PER_SESSION;

export default defineEval({
  description: "Workflow stress: 50 durable sessions complete 100 total turns.",
  tags: ["stress", "workflow", "concurrent"],

  async test(t) {
    const sessions = Array.from({ length: SESSION_COUNT }, () => t.newSession());
    const firstTurns = await Promise.all(
      sessions.map((session, index) => session.send(markerFor(index, 1))),
    );
    const secondTurns = await Promise.all(
      sessions.map((session, index) => session.send(markerFor(index, 2))),
    );

    for (let index = 0; index < SESSION_COUNT; index += 1) {
      const first = firstTurns[index]!.expectOk();
      const second = secondTurns[index]!.expectOk();

      await t.require(first.message, equals(`stress-ack:1:${markerFor(index, 1)}`));
      await t.require(second.message, equals(`stress-ack:2:${markerFor(index, 2)}`));
      await t.require(second.sessionId, equals(first.sessionId));
    }

    await t.require(new Set(firstTurns.map((turn) => turn.sessionId)).size, equals(SESSION_COUNT));

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
