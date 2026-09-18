import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";

/**
 * Core session-route runtime behavior: multi-turn session continuity.
 *
 * Durable session continuity: the second turn runs in the same session and
 * can only answer correctly from context established in the first turn.
 */
export default defineEval({
  description: "Session runtime smoke: multi-turn.",

  async test(t) {
    const first = await t.send("My favorite word is marigold. Remember it.");
    const session = first.session;
    const independent = await t.send("Bob opened a separate chat. Greet him briefly.");
    await t.require(independent.sessionId === first.sessionId, equals(false));
    independent.event("session.started", { count: 1 });
    independent.event("turn.started", { count: 1, data: { turnId: "turn_0" } });

    const second = await session.send("What is my favorite word? Reply with just the word.");

    await t.require(second.sessionId, equals(first.sessionId));
    await t.require(second.session === session, equals(true));
    second.messageIncludes(/marigold/i);

    const cancel = await session.cancel();
    await t.require(
      cancel,
      satisfies(
        (value: typeof cancel) =>
          value.status === "accepted" && value.sessionId === first.sessionId,
        "the parked session accepts cancellation through its stable address",
      ),
    );

    const third = await session.send(
      "Alice is checking the saved conversation. What favorite word did I ask you to remember? Reply with just that word.",
    );
    await t.require(third.sessionId, equals(first.sessionId));
    third.notEvent("session.started");
    third.notEvent("turn.cancelled");
    third.notEvent("session.failed");
    third.messageIncludes(/marigold/i);

    const reconnected = await t.target.attachSession(first.sessionId);
    const fourth = await reconnected.send(
      "Alice reopened the project chat. What favorite word did she ask you to remember at the beginning? Reply with just the word.",
    );
    fourth.expectOk();
    fourth.notEvent("session.started");
    fourth.event("turn.started", { count: 1, data: { sequence: 3 } });
    fourth.messageIncludes(/marigold/i);

    t.succeeded();
    t.messageIncludes(/marigold/i);
    t.check(session.transcript, includes("User:\nMy favorite word is marigold. Remember it."));
    t.check(session.transcript, includes("Assistant:\n"));
  },
});
