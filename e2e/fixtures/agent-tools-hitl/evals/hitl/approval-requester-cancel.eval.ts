import { defineEval } from "eve/evals";

const ALICE = { "x-eve-fixture-user": "alice", "x-eve-fixture-model": "continuation" };
const BOB = { "x-eve-fixture-user": "bob", "x-eve-fixture-model": "continuation" };
const TOOL = "authorized-change";

/**
 * Alice prepares a change that needs approval. The approval's response policy
 * lets only the person who requested it cancel it. Bob's Cancel is rejected
 * and the request stays pending; Alice's Cancel then settles it.
 */
export default defineEval({
  description: "An approval response policy sees the request's requester and authorizes Cancel.",
  tags: ["hitl", "authorization", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session({ headers: ALICE });
    const parked = await session.send("Prepare an authorized change.", { headers: ALICE });
    const { requestId } = parked.session.requireInputRequest({ toolName: TOOL });

    const refused = await session.respond([{ optionId: "cancel", requestId }], { headers: BOB });
    refused.event("delivery.admitted", { count: 1, data: { principal: { id: "bob" } } });
    refused.event("response.submitted", { count: 1, data: { interactionId: requestId } });
    refused.event("response.settled", {
      count: 1,
      data: { outcome: "refused", reason: "Only the requester can cancel this change." },
    });
    refused.notEvent("interaction.settled");

    const cancelled = await session.respond([{ optionId: "cancel", requestId }], {
      headers: ALICE,
    });
    cancelled.event("delivery.admitted", { count: 1, data: { principal: { id: "alice" } } });
    cancelled.event("interaction.settled", {
      count: 1,
      data: { interactionId: requestId, outcome: "declined" },
    });
    cancelled.calledTool(TOOL, { status: "completed", count: 0 });
    t.succeeded();
  },
});
