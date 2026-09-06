import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "Direct tools preserve optional arguments with mutually exclusive scopes.",
  async test(t) {
    const turn = await t.send(
      'Call lookup-scope directly with query "scope-probe". Omit queries. Reply with the requested value returned by the tool.',
    );
    turn.expectOk();
    t.succeeded();
    t.calledTool("lookup-scope", {
      input: { query: "scope-probe" },
      output: { requested: ["scope-probe"] },
    });
  },
});
