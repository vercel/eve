import { defineEval } from "eve/evals";

export default defineEval({
  description: "session.compact() rewrites history with the agent's own compaction strategy.",
  async test(t) {
    const session = await t.session();
    const opening = await session.send("Alice's project code word is ORCHID-42.");
    opening.expectOk();
    const second = await session.send("Bob joins Alice's project this week.");
    second.expectOk();

    const compacted = await session.compact();
    compacted.event("context.settled", {
      count: 1,
      data: { kind: "compaction", outcome: "completed" },
    });

    const recall = await session.send("Please verify Alice's project notes.");
    recall.expectOk();
    recall.messageIncludes("CUSTOM_COMPACTION_OK");
  },
});
