import { defineEval } from "eve/evals";

const CASE = "[case: custom-strategy]";

export default defineEval({
  description:
    "A hook asks for the compaction and the agent's own compaction.ts decides what stays, with no summary; memory is still recalled.",
  async test(t) {
    const session = await t.session();
    for (let index = 0; index < 4; index += 1) {
      const seed = await session.send(`${CASE} record evidence ${index}.`);
      seed.expectOk();
      seed.notEvent("context.settled", { data: { kind: "compaction", outcome: "completed" } });
    }
    const pressure = await session.send(`${CASE} report high usage.`);
    pressure.expectOk();
    const compacted = await session.send(`${CASE} verify the history.`);
    compacted.expectOk();
    compacted.event("context.started", { data: { kind: "compaction" } });
    compacted.event("context.settled", { data: { kind: "compaction", outcome: "completed" } });
    compacted.messageIncludes("CUSTOM_STRATEGY_OK");
  },
});
