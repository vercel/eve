import { defineEval } from "eve/evals";
import { expectNestedDelegation } from "./fixture.js";

export default defineEval({
  tags: ["real-model"],
  timeoutMs: 240_000,
  description:
    "The built-in agent waits for its nested worker, and the worker's result reaches the caller in the same turn.",
  async test(t) {
    await expectNestedDelegation(t, {
      delegate: "agent",
      handoff: `Call the tool named "agent" exactly once, with the note below as its message argument.
Your handoff tool for this request is "agent"; that copy of you will contact verification-worker.`,
    });
  },
});
