import { defineEval } from "eve/evals";

export default defineEval({
  description: "An invalid evaluation response is reported as a tool error.",
  async test(t) {
    const turn = await t.send(
      "Bob uses evaluate-request to review a missing answer from the evaluation service.",
    );
    turn.expectOk();
    turn.calledTool("evaluate-request");
    turn.messageIncludes('"isError":true');
    t.succeeded();
  },
});
