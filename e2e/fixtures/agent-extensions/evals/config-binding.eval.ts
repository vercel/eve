import { defineEval } from "eve/evals";

// A mounted extension's tool reads config bound at the mount
// (toolkit({ apiKey: "sk-e2e-toolkit", tier: "pro" })). The tool is exposed
// under its mount-namespaced name, toolkit__toolkit_lookup.
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
