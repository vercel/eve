import { defineEval } from "eve/evals";

import {
  BOB,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  bobSteers,
} from "../helpers.ts";

/**
 * Bob adds a status question to Alice's turn, then Alice asks for a release with Bob's token. The
 * tool names Bob with `ctx.getToken(provider, { as })`. Alice spoke last, so eve asks Bob: Alice's
 * press is refused, and Bob's approval runs the call with his token.
 */
export default defineEval({
  description: "A call that names another person with as asks that person first.",
  tags: ["hitl", "authorization", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");
    (await session.send(SAY.bobStatus, bobSteers)).expectOk();

    const asked = (
      await session.send(SAY.aliceBobToken, { ...asAlice, turnPolicy: "steer" })
    ).expectOk();
    const identity = approvalFor(asked, "named-token");
    asked.event("interaction.opened", {
      count: 1,
      data: { audience: { principalIds: [BOB] }, interactionId: identity.interactionId },
    });

    const refused = await session.startRespond(answers("approve", identity), asAlice);
    await refused.waitForEvent("response.settled", {
      data: { outcome: "refused", reason: (reason) => reason?.startsWith("Only bob") ?? false },
    });
    // A press its sender may not give settles its delivery as refused.
    (await refused.result()).event("delivery.settled", { count: 1, data: { outcome: "refused" } });

    const approved = (await session.respond(answers("approve", identity), asBob)).expectOk();
    approved.calledTool("named-token", {
      status: "completed",
      output: { token: "release-token:bob" },
      count: 1,
    });

    const done = (await session.respond(answers("approve", request), asAlice)).expectOk();
    done.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
