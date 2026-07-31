import { defineEval } from "eve/evals";

export default defineEval({
  description: "A subagent-mounted extension tool resolves its extension-owned lib dependency.",
  async test(t) {
    const parent = await t.start(
      "Call the extension-specialist subagent exactly once. After it returns, report its result verbatim.",
    );
    const called = await parent.waitForEvent("subagent.called", {
      data: { name: "extension-specialist" },
    });
    const child = t.target.watchTurn(called.data.childSessionId);
    const [parentTurn, childTurn] = await Promise.all([parent.result(), child.result()]);

    parentTurn.succeeded();
    parentTurn.calledSubagent("extension-specialist", { count: 1, status: "completed" });
    childTurn.succeeded();
    childTurn.calledTool("toolkit__toolkit_forecast", {
      count: 1,
      output: { token: "toolkit-forecast-ok-9F4Q" },
    });
  },
});
