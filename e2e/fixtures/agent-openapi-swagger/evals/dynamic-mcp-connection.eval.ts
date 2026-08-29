import { defineEval } from "eve/evals";

export default defineEval({
  description: "A session-scoped dynamic MCP connection is exposed to the model.",

  async test(t) {
    await t.send("DYNAMIC_MCP_CONNECTION_E2E");

    t.succeeded();
    t.messageIncludes("DYNAMIC_MCP_CONNECTION_FOUND");
  },
});
