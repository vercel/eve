import { defineEval } from "eve/evals";

export default defineEval({
  description: "A request over the threshold compacts with the agent's own compaction strategy.",
  async test(t) {
    const session = await t.session();
    const opening = await session.send("Alice's project code word is ORCHID-42.");
    opening.expectOk();
    const measured = await session.send("Alice's notes report high usage today.");
    measured.expectOk();
    measured.notEvent("context.settled", { data: { kind: "compaction" } });

    const recall = await session.send("Please verify Alice's project notes.");
    recall.expectOk();
    recall.event("context.settled", { data: { kind: "compaction", outcome: "completed" } });
    recall.messageIncludes("CUSTOM_COMPACTION_OK");
  },
});
