import { defineEval } from "eve/evals";

import {
  ALICE,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  bobSteers,
  expectWaitsAsTask,
} from "../helpers.ts";

/**
 * Bob's note joins Alice's turn while her change waits for approval, and asks for a release with
 * Alice's token. The call stops, and eve asks Alice to approve it, quoting Bob. Bob presses
 * Approve too, and only Alice's approval counts: the call runs again with her token. Her approval
 * then runs the change.
 */
export default defineEval({
  description: "The caller is asked before a call uses their token after someone else speaks.",
  tags: ["hitl", "authorization", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const asked = (await session.send(SAY.bobCallerToken, bobSteers)).expectOk();
    const identity = approvalFor(asked, "caller-token");
    asked.event("interaction.opened", {
      count: 1,
      data: {
        audience: { principalIds: [ALICE] },
        interactionId: identity.interactionId,
        request: { kind: "approval", prompt: (prompt) => prompt.includes(SAY.bobCallerToken) },
      },
    });
    asked.notEvent("call.settled", { data: { callId: identity.call?.callId } });
    expectWaitsAsTask(asked, request);

    const refused = await session.startRespond(answers("approve", identity), asBob);
    await refused.waitForEvent("response.settled", {
      data: { outcome: "refused", reason: (reason) => reason?.startsWith("Only alice") ?? false },
    });
    // A press its sender may not give settles its delivery as refused.
    (await refused.result()).event("delivery.settled", { count: 1, data: { outcome: "refused" } });

    const approved = (await session.respond(answers("approve", identity), asAlice)).expectOk();
    approved.calledTool("caller-token", {
      status: "completed",
      output: { token: "release-token:alice" },
      count: 1,
    });

    const done = (await session.respond(answers("approve", request), asAlice)).expectOk();
    done.calledTool("change-a", { status: "completed", count: 1 });
    done.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
