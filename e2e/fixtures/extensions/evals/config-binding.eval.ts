import { defineEval } from "eve/evals";

export default defineEval({
  description: "Mounted extension tool returns the config bound at the mount site.",
  async test(t) {
    await t.send(
      "Call the `toolkit__toolkit_lookup` tool with account 'acme' and report exactly what it returned.",
    );

    t.succeeded();
    t.calledTool("toolkit__toolkit_lookup", {
      output: { account: "acme", apiKey: "sk-e2e-toolkit", tier: "pro" },
    });
  },
});
