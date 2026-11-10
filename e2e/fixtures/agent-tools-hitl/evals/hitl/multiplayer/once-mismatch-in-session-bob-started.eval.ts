import { defineEval } from "eve/evals";

import { BOB, REPLY, SAY, answers, approvalFor, as, asAlice, asBob } from "../helpers.ts";

/**
 * Bob starts the session, then Alice asks for the shared change, whose approval is
 * `once({ when: "principal-mismatch" })`. Alice isn't the session's initiator, so she is asked
 * once. Her approval covers her next request for the same change.
 */
export default defineEval({
  description: "once({ when }) asks the caller once in a session someone else started.",
  tags: ["hitl", "approval", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session(as(BOB));
    (await session.send(SAY.bobStatus, asBob)).expectOk().messageIncludes(REPLY.bobStatus);

    const shared = approvalFor(await session.send(SAY.sharedChange, asAlice), "shared-change");
    const approved = (await session.respond(answers("approve", shared), asAlice)).expectOk();
    approved.calledTool("shared-change", {
      status: "completed",
      output: { actor: "alice" },
      count: 1,
    });

    const again = (await session.send(SAY.sharedChangeAgain, asAlice)).expectOk();
    again.notEvent("interaction.opened");
    again.calledTool("shared-change", {
      status: "completed",
      output: { actor: "alice" },
      count: 1,
    });
  },
});
