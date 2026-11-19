import { defineEval } from "eve/evals";

import { authorizationFrom, completeAuthorization, expectHeld, follow } from "../helpers.ts";
import { asAliceWithSubagent, MODEL_SIGN_IN, MODEL_TOKEN } from "./shared.ts";

/**
 * Alice asks the parent, and the parent delegates to a subagent on her own model credential.
 * The subagent's sign-in reaches Alice's session; after the callback, the subagent answers with
 * her token, and the parent reports that answer in the same turn.
 */
export default defineEval({
  description:
    "A declared subagent's model sign-in reaches the root session and continues the child.",
  tags: ["hitl", "authorization", "model-sign-in"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await t.session(asAliceWithSubagent);
    const held = await session.send(
      "Alice asks the child agent for today's summary.",
      asAliceWithSubagent,
    );
    expectHeld(held);
    held.event("interaction.opened", {
      count: 1,
      data: { request: { kind: "sign-in", signIn: { name: MODEL_SIGN_IN } } },
    });
    const authorization = authorizationFrom(held);

    const startIndex = session.state.streamIndex;
    await completeAuthorization(t, authorization.url);
    const answered = (await follow(t, session, startIndex)).expectOk();
    answered.notEvent("turn.started");
    answered.event("interaction.settled", {
      count: 1,
      data: { interactionId: authorization.attemptId, outcome: "accepted" },
    });
    answered.event("content.completed", {
      data: { phase: "reply", value: `Child answered: Answered with ${MODEL_TOKEN}.` },
    });
  },
});
