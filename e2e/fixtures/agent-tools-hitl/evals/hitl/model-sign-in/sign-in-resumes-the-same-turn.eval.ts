import { defineEval } from "eve/evals";

import {
  authorizationFrom,
  completeAuthorization,
  expectHeld,
  expectNoModelCallDuringAuthorization,
  follow,
} from "../helpers.ts";
import { asAliceOnOwnCredential, MODEL_SIGN_IN, MODEL_TOKEN } from "./shared.ts";

/**
 * Alice's agent runs on her own model credential, and she has none yet. eve asks her to sign in
 * before the model call; after the callback, the same turn answers with her token.
 */
export default defineEval({
  description: "A model without the caller's credential asks, then answers in the same turn.",
  tags: ["hitl", "authorization", "model-sign-in"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session(asAliceOnOwnCredential);
    const held = await session.send("Alice asks for today's summary.", asAliceOnOwnCredential);
    expectHeld(held);
    held.event("interaction.opened", {
      count: 1,
      data: { request: { kind: "sign-in", signIn: { name: MODEL_SIGN_IN } } },
    });
    held.notEvent("model.requested");
    const authorization = authorizationFrom(held);

    const startIndex = session.state.streamIndex;
    await completeAuthorization(t, authorization.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.notEvent("turn.started");
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: authorization.attemptId, outcome: "accepted" },
    });
    resumed.event("content.completed", {
      data: { phase: "reply", value: `Answered with ${MODEL_TOKEN}.` },
    });
    expectNoModelCallDuringAuthorization(resumed, authorization.attemptId, held.events);
  },
});
