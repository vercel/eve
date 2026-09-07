import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Growing instructions and tool schemas trigger compaction above prior provider usage.",
  async test(t) {
    for (let index = 0; index < 6; index += 1) {
      const seed = await t.send(
        `Seed ${index}: ${"Preserve this repository evidence. ".repeat(40)}`,
      );
      seed.expectOk();
      seed.event("compaction.completed", { count: 0 });
    }
    const expanded = await t.send(
      "[expand-envelope] Verify that the expanded request was compacted.",
    );
    expanded.expectOk();
    expanded.event("compaction.completed", { count: 1 });
    expanded.messageIncludes("DYNAMIC_ENVELOPE_COMPACTED");
  },
});
