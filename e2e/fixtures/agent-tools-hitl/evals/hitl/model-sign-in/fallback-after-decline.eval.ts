import { defineEval } from "eve/evals";

import { authorizationFrom, completeAuthorization, expectHeld, follow } from "../helpers.ts";
import { asAliceWithFallback, declined, PROJECT_MODEL_REPLY } from "./shared.ts";

/**
 * Alice declines the model sign-in, and the agent's dynamic model reads the decline from the
 * session view. It picks the project's model, which answers in the same turn.
 */
export default defineEval({
  description: "A dynamic model falls back to another model after a declined model sign-in.",
  tags: ["hitl", "authorization", "model-sign-in"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session(asAliceWithFallback);
    const held = await session.send("Alice asks for today's summary.", asAliceWithFallback);
    expectHeld(held);
    const authorization = authorizationFrom(held);

    const startIndex = session.state.streamIndex;
    await completeAuthorization(t, declined(authorization.url));
    const answered = (await follow(t, session, startIndex)).expectOk();
    answered.notEvent("turn.started");
    answered.event("interaction.settled", {
      count: 1,
      data: { interactionId: authorization.attemptId, outcome: "declined" },
    });
    answered.event("content.completed", { data: { phase: "reply", value: PROJECT_MODEL_REPLY } });
  },
});
