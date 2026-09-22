import { defineEval } from "eve/evals";

import { runProbe } from "./agent-probe.shared.ts";

export default defineEval({
  description: "Blocking local workflow subagent proxies human approval.",
  timeoutMs: 90_000,
  async test(t) {
    await runProbe(t, { kind: "hitl" });
  },
});
