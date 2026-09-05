import { defineEval } from "eve/evals";
import { runRejectedStepAuth } from "./agent-probe.shared.ts";

export default defineEval({
  description:
    "Workflow step authorization fails when a fresh token is rejected, without another sign-in prompt.",
  timeoutMs: 90_000,
  async test(t) {
    await runRejectedStepAuth(t);
  },
});
