import { defineEval } from "eve/evals";

import { requireToolOutput } from "./shared.js";

// The resolver increments a state counter and branches on it. If it
// truly runs once per session, both turns see { branch: "first" }; a
// re-run would surface { branch: "reran" }.
export default defineEval({
  description: "Dynamic tools smoke: the resolver runs once per session, not per turn.",
  async test(t) {
    const first = await t.send(
      "Use the `dynamic-conditional__check_stability` tool and tell me the branch and invocations values.",
    );
    first.expectOk();
    const firstOutput = requireToolOutput(first, "dynamic-conditional__check_stability");
    if (firstOutput.branch !== "first") {
      throw new Error(`Turn 1: expected branch="first", got ${JSON.stringify(firstOutput.branch)}`);
    }

    const second = await t.send(
      "Use the `dynamic-conditional__check_stability` tool to check stability. Call it now and report the branch and invocations values.",
    );
    second.expectOk();
    const secondOutput = requireToolOutput(second, "dynamic-conditional__check_stability");
    if (secondOutput.branch !== "first") {
      throw new Error(
        `Turn 2: expected branch="first" (resolver should not re-run conditional logic), ` +
          `got branch=${JSON.stringify(secondOutput.branch)}, invocations=${JSON.stringify(secondOutput.invocations)}.`,
      );
    }

    t.didNotFail();
    t.completed();
    t.calledTool("dynamic-conditional__check_stability", {
      isError: false,
      output: { branch: "first" },
      times: 2,
    });
  },
});
