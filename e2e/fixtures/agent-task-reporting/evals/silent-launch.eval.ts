import { defineEval } from "eve/evals";

import { startWarehouseLookups, waitForPartialCompletion, waitForReport } from "./reporting.js";

export default defineEval({
  description:
    "Alice follows background warehouse checks in an activity card, then receives the completed inventory report without a separate launch acknowledgement.",
  tags: ["real-model", "silent-launch"],
  async test(t) {
    const run = await startWarehouseLookups(t, "cohort-silent");
    await waitForPartialCompletion(t, run);
    await waitForReport(t, run);
    t.noFailedActions();
  },
});
