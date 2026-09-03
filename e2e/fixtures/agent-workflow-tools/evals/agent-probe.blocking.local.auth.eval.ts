import { defineEval } from "eve/evals";

import { runProbe } from "./agent-probe.shared.ts";

export default defineEval({
  description: "Blocking local workflow subagent proxies interactive authorization.",
  timeoutMs: 90_000,
  async test(t) {
    await runProbe(t, { kind: "auth" });
  },
});
