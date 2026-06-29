import { defineEval } from "eve/evals";

// The resolver increments a state counter and branches on it. If it
// truly runs once per session, both turns see { branch: "first" }; a
// re-run would surface { branch: "reran" }.
export default defineEval({
  description: "Dynamic tools smoke: the resolver runs once per session, not per turn.",
  async test(t) {
    const first = await t.send(
      "Use the `check_stability` tool and tell me the branch and invocations values.",
    );
    first.expectOk();
    first.calledTool("check_stability", {
      output: { branch: "first" },
    });

    const second = await t.send(
      "Use the `check_stability` tool to check stability. Call it now and report the branch and invocations values.",
    );
    second.calledTool("check_stability", {
      output: { branch: "first" },
    });

    t.succeeded();
    t.calledTool("check_stability", {
      output: { branch: "first" },
      count: 2,
    });
  },
});
