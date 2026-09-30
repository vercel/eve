import { defineEval } from "eve/evals";

export default defineEval({
  description: "Two mounts of one extension keep separate config and durable state.",
  async test(t) {
    await t.send(
      "Call toolkit__toolkit_lookup with account 'primary', then toolkit-alt__toolkit_lookup with account 'secondary'. Bump toolkit's budget twice and toolkit-alt's budget once. Report the lookup configuration and each budget count.",
    );

    t.succeeded();
    t.calledTool("toolkit__toolkit_lookup", {
      output: { account: "primary", apiKey: "sk-e2e-toolkit", tier: "pro" },
    });
    t.calledTool("toolkit-alt__toolkit_lookup", {
      output: { account: "secondary", apiKey: "sk-e2e-toolkit-alt", tier: "enterprise" },
    });
    t.calledTool("toolkit__toolkit_budget", { output: { scope: "toolkit", count: 2 } });
    t.calledTool("toolkit-alt__toolkit_budget", { output: { scope: "toolkit", count: 1 } });
  },
});
