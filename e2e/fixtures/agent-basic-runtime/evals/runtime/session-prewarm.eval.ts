import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "A prewarmed workflow initializes only when its first message arrives.",
  async test(t) {
    const session = await t.session();
    const sessionId = session.sessionId;
    const message = `Alice opened this chat while the session warmed up. Greet her briefly and include reference ${crypto.randomUUID()}.`;
    const live = await session.start(message);
    const observed = t.target.watchTurn(live.sessionId, { startIndex: 0 });
    const [result, streamed] = await Promise.all([live.result(), observed.result()]);

    result.expectOk();
    await t.require(result.sessionId, equals(sessionId));
    result.event("session.started", { count: 1 });
    result.event("turn.started", { count: 1, data: { turnId: "turn_0" } });
    result.event("message.received", { count: 1, data: { message, turnId: "turn_0" } });
    result.event("step.started", { count: 1, data: { turnId: "turn_0" } });
    await t.require(
      streamed.events.map((event) => event.meta.id),
      equals(result.events.map((event) => event.meta.id)),
    );
  },
});
