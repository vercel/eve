import { defineEval } from "eve/evals";

// A dynamic resolver (override-provider.ts) emits a tool named `override-target`,
// the same name as an authored tool. The dynamic tool must win: calling
// `override-target` returns the dynamic result, never the authored
// `source: "authored"`.
const OVERRIDE_TOKEN = "dynamic-override-ok-K2P7";

export default defineEval({
  description: "Dynamic tools smoke: a dynamic tool overrides a same-named authored tool.",
  async test(t) {
    const turn = await t.send(
      "Call the `override-target` tool and report the `source` value it returns.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("override-target", {
      isError: false,
      output: { source: "dynamic", token: OVERRIDE_TOKEN },
    });
  },
});
