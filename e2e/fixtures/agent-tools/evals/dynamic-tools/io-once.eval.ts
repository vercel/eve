import { defineEval } from "eve/evals";

// The resolver's simulated I/O runs once; the durable cache replays its
// result on the second turn so ioCallCount stays at 1.
export default defineEval({
  description: "Dynamic tools smoke: resolver I/O runs once and replays from the durable cache.",
  async test(t) {
    const first = await t.send(
      "Use the `get_io_count` tool and tell me the ioCallCount number from the result.",
    );
    first.expectOk();
    first.calledTool("get_io_count", {
      output: { ioCallCount: 1 },
    });

    const second = await t.send(
      "Use the `get_io_count` tool again right now and tell me the ioCallCount value from the result.",
    );
    second.calledTool("get_io_count", {
      output: { ioCallCount: 1 },
    });

    t.succeeded();
    t.calledTool("get_io_count", {
      output: { ioCallCount: 1 },
    });
  },
});
