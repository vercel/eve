import { defineEval } from "eve/evals";

import { MEASURED_TOKENS_CASE } from "../agent/lib/measured-tokens";

export default defineEval({
  description:
    "Provider-measured context pressure produces a summary even when the character estimate is small.",
  async test(t) {
    for (let index = 0; index < 6; index += 1) {
      const seed = await t.send(`${MEASURED_TOKENS_CASE} record evidence ${index}.`);
      seed.expectOk();
      seed.notEvent("compaction.completed");
    }
    const measured = await t.send(`${MEASURED_TOKENS_CASE} report high usage.`);
    measured.expectOk();
    const compacted = await t.send(`${MEASURED_TOKENS_CASE} verify the checkpoint.`);
    compacted.expectOk();
    compacted.event("compaction.completed");
    compacted.messageIncludes("MEASURED_COMPACTION_OK");
  },
});
