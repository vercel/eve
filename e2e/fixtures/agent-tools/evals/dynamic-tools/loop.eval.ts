import { defineEval } from "eve/evals";

// Tools generated inside a for loop keep their per-iteration closures.
export default defineEval({
  description: "Dynamic tools smoke: loop-generated tools keep per-iteration closures.",
  async test(t) {
    const turn = await t.send(
      "Call the `dynamic-loop__alpha` tool and tell me the name and index it returned.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("dynamic-loop__alpha", {
      isError: false,
      output: { name: "alpha", index: 0 },
    });
  },
});
