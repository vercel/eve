import { defineEval } from "eve/evals";

import { SAY, aliceSession, answers, approvalFor, asAlice, bobSteers } from "../helpers.ts";

/**
 * Bob's note joins Alice's turn and asks for the shared change, whose approval is
 * `once({ when: "principal-mismatch" })`. Alice is asked, because Bob spoke last. When Bob asks for
 * it again in her next turn, her earlier approval covers it, so she isn't asked again.
 */
export default defineEval({
  description: "once({ when }) asks the caller once for each person who spoke last.",
  tags: ["hitl", "approval", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const change = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");
    await session.start(SAY.bobSharedChange, bobSteers);
    const asked = await session.respond(answers("approve", change), asAlice);
    const shared = approvalFor(asked, "shared-change");
    const approved = (await session.respond(answers("approve", shared), asAlice)).expectOk();
    approved.calledTool("shared-change", {
      status: "completed",
      output: { actor: "alice" },
      count: 1,
    });

    const again = approvalFor(await session.send(SAY.changeAAgain, asAlice), "change-a");
    await session.start(SAY.bobSharedChangeAgain, bobSteers);
    const remembered = (await session.respond(answers("approve", again), asAlice)).expectOk();
    remembered.notEvent("interaction.opened");
    remembered.calledTool("shared-change", {
      status: "completed",
      output: { actor: "alice" },
      count: 1,
    });
  },
});
