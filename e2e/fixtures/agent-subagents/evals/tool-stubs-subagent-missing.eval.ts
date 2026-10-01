import { defineEval } from "eve/evals";

export default defineEval({
  description: "Tool stubs: a subagent's call without a stub fails the root turn too.",
  // Stub sets are accepted only by the local server `eve eval` starts.
  tags: ["tool-stubs", "local-server"],
  timeoutMs: 120_000,
  async test(t) {
    const turn = await t.send(
      "NOTEBOOK-CORRECT notebook-keeper Alice corrects the pier she asked about.",
      { stubs: "notebook-empty" },
    );
    turn.event("turn.failed", { count: 1, data: { code: "TOOL_STUB_MISSING" } });
    turn.notEvent("message.completed");
  },
});
