import { defineEval } from "eve/evals";

const CASE = "[case: custom-strategy]";

export default defineEval({
  description:
    "An agent's own compaction.ts decides when to compact and what stays, with no summary; memory is still recalled.",
  async test(t) {
    const session = await t.session();
    for (let index = 0; index < 4; index += 1) {
      const seed = await session.send(`${CASE} record evidence ${index}.`);
      seed.expectOk();
      seed.notEvent("compaction.completed");
    }
    const pressure = await session.send(`${CASE} report high usage.`);
    pressure.expectOk();
    const compacted = await session.send(`${CASE} verify the history.`);
    compacted.expectOk();
    compacted.event("compaction.requested");
    compacted.event("compaction.completed");
    compacted.messageIncludes("CUSTOM_STRATEGY_OK");
  },
});
