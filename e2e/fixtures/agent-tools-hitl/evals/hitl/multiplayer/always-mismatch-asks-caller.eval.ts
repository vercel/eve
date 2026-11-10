import { defineEval } from "eve/evals";

import { SAY, aliceSession, answers, approvalFor, asAlice, asBob, bobSteers } from "../helpers.ts";

/**
 * Bob's note joins Alice's turn and asks for the team-only change, whose approval is
 * `always({ when: "principal-mismatch" })`. Alice is asked, because Bob spoke last. Bob can't
 * approve a call that runs as Alice; Alice's approval runs it.
 */
export default defineEval({
  description: "always({ when }) asks the caller after someone else speaks; only they approve.",
  tags: ["hitl", "approval", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const change = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    await session.start(SAY.bobTeamChange, bobSteers);
    const asked = await session.respond(answers("approve", change), asAlice);
    const team = approvalFor(asked, "team-change");

    const refused = await session.respond(answers("approve", team), asBob);
    refused.event("response.settled", {
      count: 1,
      data: {
        outcome: "refused",
        reason:
          "Only the person who requested this action can approve it, because it runs as them.",
      },
    });
    refused.notEvent("interaction.settled");

    const approved = (await session.respond(answers("approve", team), asAlice)).expectOk();
    approved.calledTool("team-change", {
      status: "completed",
      output: { actor: "alice" },
      count: 1,
    });
  },
});
