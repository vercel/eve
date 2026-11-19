import { defineEval } from "eve/evals";

import { authorizationFrom, completeAuthorization, expectHeld, follow } from "../helpers.ts";
import { asAliceOnOwnCredential, declined, expectAuthorizationFailed } from "./shared.ts";

/**
 * Alice declines the model sign-in. With no other model to fall back to, the turn fails with
 * `MODEL_AUTHORIZATION_FAILED`; the session stays open, and her next message asks again.
 */
export default defineEval({
  description: "A declined model sign-in fails the turn, and the next turn asks again.",
  tags: ["hitl", "authorization", "model-sign-in"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session(asAliceOnOwnCredential);
    const held = await session.send("Alice asks for today's summary.", asAliceOnOwnCredential);
    expectHeld(held);
    const authorization = authorizationFrom(held);

    const startIndex = session.state.streamIndex;
    await completeAuthorization(t, declined(authorization.url));
    const failed = await follow(t, session, startIndex);
    failed.event("interaction.settled", {
      count: 1,
      data: { interactionId: authorization.attemptId, outcome: "declined" },
    });
    failed.notEvent("model.requested");
    failed.notEvent("session.ended");
    expectAuthorizationFailed(failed);

    const again = await session.send("Alice asks for the summary again.", asAliceOnOwnCredential);
    expectHeld(again);
    again.event("interaction.opened", { count: 1, data: { request: { kind: "sign-in" } } });
  },
});
