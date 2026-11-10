import { defineEval } from "eve/evals";

/**
 * A sign-in holds the turn, as a question or task does. A message from the same person joins that
 * turn while the sign-in stays open, so the model answers the message instead of the turn waiting
 * silently. Callback completion and tool re-execution are covered deterministically by
 * `entry-sign-in.integration.test.ts`.
 */
export default defineEval({
  description: "A message from the same person joins a turn held on sign-in, which stays open.",
  async test(t) {
    const held = await t.send(
      'Call the auth-probe tool exactly once with marker "nonblocking". Include its result.',
    );
    const session = held.session;
    held.event("interaction.opened", { count: 1, data: { request: { kind: "sign-in" } } });
    held.notEvent("interaction.settled");
    held.event("turn.paused", { count: 1 });
    held.notEvent("turn.settled");

    const joined = await session.send(
      "While that sign-in waits, do not call any tools. Reply with exactly AUTH-OPEN-MESSAGE-OK.",
    );
    joined.expectOk();
    if (joined.sessionId !== held.sessionId) {
      throw new Error("Joining the held turn changed session identity.");
    }
    joined.notEvent("interaction.settled");
    joined.notEvent("interaction.opened");
    joined.notEvent("turn.started");
    joined.notEvent("turn.settled");
    joined.messageIncludes("AUTH-OPEN-MESSAGE-OK");
  },
});
