import { defineEval } from "eve/evals";

/**
 * A sign-in holds the turn, as a question or task does. A message from the
 * same person steers that turn and cancels the sign-in, so the turn moves on
 * instead of waiting. Callback completion and tool re-execution are covered
 * deterministically by `entry-authorization.integration.test.ts`.
 */
export default defineEval({
  description: "A message from the same person steers a turn held on sign-in and cancels it.",
  async test(t) {
    const held = await t.send(
      'Call the auth-probe tool exactly once with marker "nonblocking". Include its result.',
    );
    const session = held.session;
    held.event("interaction.opened", { count: 1, data: { request: { kind: "sign-in" } } });
    held.notEvent("interaction.settled");
    held.event("turn.paused", { count: 1 });
    held.notEvent("turn.settled");

    const steered = await session.send(
      "Never mind the probe. Do not call any tools. Reply with exactly AUTH-OPEN-MESSAGE-OK.",
    );
    steered.expectOk();
    if (steered.sessionId !== held.sessionId) {
      throw new Error("Steering the held turn changed session identity.");
    }
    steered.event("interaction.settled", { count: 1, data: { outcome: "withdrawn" } });
    steered.notEvent("turn.started");
    steered.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    steered.messageIncludes("AUTH-OPEN-MESSAGE-OK");
  },
});
