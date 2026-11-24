import { defineEval } from "eve/evals";

export default defineEval({
  description: "An invalid extraction response is reported as a tool error.",
  async test(t) {
    const turn = await t.send(
      "Bob uses extract-request to review a missing answer from the extraction service.",
    );
    turn.expectOk();
    turn.calledTool("extract-request", { status: "failed", count: 1 });
    turn.messageIncludes('"isError":true');
    t.succeeded();
  },
});
