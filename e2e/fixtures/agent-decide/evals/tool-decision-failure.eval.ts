import { defineEval } from "eve/evals";

export default defineEval({
  description: "An invalid decision response is reported as a tool error.",
  async test(t) {
    const turn = await t.send(
      "Bob uses decide-request to review a missing answer from the decision service.",
    );
    turn.expectOk();
    turn.calledTool("decide-request", { status: "failed", count: 1 });
    turn.messageIncludes('"isError":true');
    t.succeeded();
  },
});
