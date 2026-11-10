import { defineEval } from "eve/evals";

import { SAY, aliceSession, answers, approvalFor, asAlice, asBob } from "../helpers.ts";

/**
 * Alice tells the agent Bob's change is ready to ship for him. The tool's `actor` input names
 * Bob, so Bob is asked: Alice's approval is refused, and Bob's runs the change with his token.
 */
export default defineEval({
  description: "A tool's actor input asks the person it names and runs with their token.",
  tags: ["hitl", "approval", "authorization", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.actorForBob, asAlice), "actor-change");

    const refused = await session.respond(answers("approve", request), asAlice);
    refused.event("response.settled", {
      count: 1,
      data: { outcome: "refused", reason: "Only the person this change is for can approve it." },
    });
    refused.notEvent("interaction.settled");

    const approved = (await session.respond(answers("approve", request), asBob)).expectOk();
    approved.calledTool("actor-change", {
      status: "completed",
      output: { actor: "bob", token: "release-token:bob" },
      count: 1,
    });
  },
});
