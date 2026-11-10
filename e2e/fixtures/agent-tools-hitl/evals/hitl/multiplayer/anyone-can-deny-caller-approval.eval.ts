import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  bobSteers,
  expectNotRun,
} from "../helpers.ts";

/**
 * Bob's note joins Alice's turn and asks for the team-only change, so Alice is asked to approve
 * it. Only Alice can approve a call that runs as her, but anyone can stop it: Bob's Cancel
 * declines it, and the change never runs.
 */
export default defineEval({
  description: "Anyone can cancel an approval only the caller can give.",
  tags: ["hitl", "approval", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const change = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    await session.start(SAY.bobTeamChange, bobSteers);
    const asked = await session.respond(answers("approve", change), asAlice);
    const team = approvalFor(asked, "team-change");

    const declined = await session.respond(answers("deny", team), asBob);
    declined.event("interaction.settled", {
      count: 1,
      data: { interactionId: team.interactionId, outcome: "declined" },
    });
    expectNotRun(declined, "team-change");
  },
});
