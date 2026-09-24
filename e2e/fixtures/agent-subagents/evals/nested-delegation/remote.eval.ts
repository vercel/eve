import { defineEval } from "eve/evals";
import { expectNestedDelegation } from "./fixture.js";

export default defineEval({
  tags: ["real-model"],
  timeoutMs: 240_000,
  description:
    "A remote subagent waits for its nested worker, and the worker's result reaches the caller in the same turn.",
  async test(t) {
    await expectNestedDelegation(t, {
      delegate: "remote-loopback",
      handoff: "Hand this off with the remote-loopback tool, using the note below as its message.",
      remote: true,
    });
  },
});
