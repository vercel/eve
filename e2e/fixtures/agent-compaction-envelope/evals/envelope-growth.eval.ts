import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Growing instructions and tool schemas trigger compaction above prior provider usage.",
  async test(t) {
    const session = await t.session();
    for (let index = 0; index < 6; index += 1) {
      const seed = await session.send(
        `Seed ${index}: ${"Preserve this repository evidence. ".repeat(40)}`,
      );
      seed.expectOk();
      seed.event("context.settled", {
        count: 0,
        data: { kind: "compaction", outcome: "completed" },
      });
    }
    const expanded = await session.send(
      "[expand-envelope] Verify that the expanded request was compacted.",
    );
    expanded.expectOk();
    expanded.event("context.settled", {
      count: 1,
      data: { kind: "compaction", outcome: "completed" },
    });
    expanded.messageIncludes("DYNAMIC_ENVELOPE_COMPACTED");
  },
});
