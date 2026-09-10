import { defineEval } from "eve/evals";

import { runRejectedStepAuth } from "./agent-probe.shared.ts";

export default defineEval({
  description:
    "If the service rejects the token after sign-in, authorization fails without prompting again.",
  timeoutMs: 90_000,

  async test(t) {
    await runRejectedStepAuth(t);
  },
});
