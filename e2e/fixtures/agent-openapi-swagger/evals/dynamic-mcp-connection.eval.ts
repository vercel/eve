import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description: "A session-scoped dynamic MCP connection is exposed to the model.",

  async test(t) {
    requireMockModel(
      t,
      "Requires the deterministic mock model; the fixture MCP endpoint is non-routable.",
    );

    await t.send("DYNAMIC_MCP_CONNECTION_E2E");

    t.succeeded();
    t.messageIncludes("DYNAMIC_MCP_CONNECTION_FOUND");
  },
});
