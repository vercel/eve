import { defineEval } from "eve/evals";

import { runStepAuth } from "./agent-probe.shared.ts";

export default defineEval({
  description: "A missing token triggers sign-in through ctx.getToken, then the step succeeds.",
  timeoutMs: 90_000,

  async test(t) {
    await runStepAuth(t, "IMPLICIT");
  },
});
