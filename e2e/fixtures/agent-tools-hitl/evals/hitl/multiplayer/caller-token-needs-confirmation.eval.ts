import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  bobSteers,
  expectWaitsAsTask,
} from "../helpers.ts";

/**
 * Bob's note joins Alice's turn while her change waits for approval, and asks for a release with
 * Alice's token. The tool's call for Alice's token is refused, because Bob spoke after her. Alice
 * then confirms in her own words, and the same tool runs with her token. Her approval finally
 * runs the change.
 */
export default defineEval({
  description: "The caller's token is refused after someone else speaks, until the caller replies.",
  tags: ["hitl", "authorization", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const refused = (await session.send(SAY.bobCallerToken, bobSteers)).expectOk();
    refused.calledTool("caller-token", { status: "failed", count: 1 });
    refused.notEvent("interaction.opened");
    refused.messageIncludes("Caller token: not run.");
    expectWaitsAsTask(refused, request);

    const confirmed = (await session.send(SAY.aliceConfirmsToken, asAlice)).expectOk();
    confirmed.calledTool("caller-token", {
      status: "completed",
      output: { token: "release-token:alice" },
      count: 1,
    });

    const approved = (await session.respond(answers("approve", request), asAlice)).expectOk();
    approved.calledTool("change-a", { status: "completed", count: 1 });
    approved.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
