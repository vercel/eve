import { defineEval } from "eve/evals";

export default defineEval({
  description: "Two mounts of one extension keep their configured accounts separate.",
  async test(t) {
    await t.send(
      "Alice is checking the primary account and Bob is checking the secondary account. Use `toolkit__toolkit_lookup` with account 'primary' for Alice, then `toolkit-alt__toolkit_lookup` with account 'secondary' for Bob. Report each lookup result.",
    );

    t.succeeded();
    t.calledTool("toolkit__toolkit_lookup", {
      output: { account: "primary", apiKey: "sk-e2e-toolkit", tier: "pro" },
    });
    t.calledTool("toolkit-alt__toolkit_lookup", {
      output: { account: "secondary", apiKey: "sk-e2e-toolkit-alt", tier: "enterprise" },
    });
  },
});
