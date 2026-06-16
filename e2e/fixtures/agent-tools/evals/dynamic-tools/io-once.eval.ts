import { defineEval } from "eve/evals";

import { requireToolOutput } from "./shared.js";

// The resolver's simulated I/O runs once; the durable cache replays its
// result on the second turn so ioCallCount stays at 1.
export default defineEval({
  description: "Dynamic tools smoke: resolver I/O runs once and replays from the durable cache.",
  async test(t) {
    const first = await t.send(
      "Use the `dynamic-counted__get_io_count` tool and tell me the ioCallCount number from the result.",
    );
    first.expectOk();
    const firstCount = requireToolOutput(first, "dynamic-counted__get_io_count").ioCallCount;
    if (firstCount !== 1) {
      throw new Error(`Turn 1: expected ioCallCount=1, got ${JSON.stringify(firstCount)}`);
    }

    const second = await t.send(
      "Use the `dynamic-counted__get_io_count` tool again right now and tell me the ioCallCount value from the result.",
    );
    second.expectOk();
    const secondCount = requireToolOutput(second, "dynamic-counted__get_io_count").ioCallCount;
    if (secondCount !== 1) {
      throw new Error(
        `Turn 2: expected ioCallCount=1 (resolver I/O should not re-run), got ${JSON.stringify(secondCount)}.`,
      );
    }

    t.didNotFail();
    t.completed();
    t.calledTool("dynamic-counted__get_io_count", {
      isError: false,
      output: { ioCallCount: 1 },
    });
  },
});
