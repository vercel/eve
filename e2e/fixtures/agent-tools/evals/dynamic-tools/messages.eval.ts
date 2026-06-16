import { defineEval } from "eve/evals";

import { requireToolOutput } from "./shared.js";

// The step.started resolver sees the accumulated message history: the
// second turn's count must exceed the first.
export default defineEval({
  description: "Dynamic tools smoke: step.started resolver sees accumulated message history.",
  async test(t) {
    const first = await t.send(
      "Use the `dynamic-messages__check_messages` tool with label 'turn1' and tell me the messageCount.",
    );
    first.expectOk();
    const firstCount = requireToolOutput(first, "dynamic-messages__check_messages").messageCount;
    if (typeof firstCount !== "number" || firstCount < 1) {
      throw new Error(
        `Turn 1: expected messageCount >= 1, got ${JSON.stringify(firstCount)}. ` +
          "Resolver should see at least the user message.",
      );
    }

    const second = await t.send(
      "Use the `dynamic-messages__check_messages` tool again with label 'turn2' and tell me the messageCount.",
    );
    second.expectOk();
    const secondCount = requireToolOutput(second, "dynamic-messages__check_messages").messageCount;
    if (typeof secondCount !== "number" || secondCount <= firstCount) {
      throw new Error(
        `Turn 2: expected messageCount > ${firstCount}, got ${JSON.stringify(secondCount)}. ` +
          "Resolver should see accumulated history.",
      );
    }

    t.didNotFail();
    t.completed();
    // The accumulated-history property is verified per-turn above
    // (firstCount >= 1, secondCount > firstCount). The model may call the
    // tool more than once in a turn, so assert it was called without error
    // rather than pinning an exact count.
    t.calledTool("dynamic-messages__check_messages", { isError: false });
  },
});
