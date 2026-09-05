import { defineEval } from "eve/evals";
import { runStepAuth } from "./agent-probe.shared.ts";

export default defineEval({
  description: "Workflow step requireAuth parks for sign-in and resumes under the requester.",
  timeoutMs: 90_000,
  async test(t) {
    await runStepAuth(t, true);
  },
});
