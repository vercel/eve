import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A session-scoped dynamic OpenAPI connection is announced in the catalog listing and searchable by name.",

  async test(t) {
    requireMockModel(
      t,
      "Requires the deterministic mock model; the fixture API endpoint is non-routable.",
    );

    const turn = await t.send("DYNAMIC_CONNECTION_E2E");

    turn.expectOk();
    turn.calledTool("search", {
      count: 1,
      input: { connection: "dynamic-catalog" },
      output: (value) => JSON.stringify(value).includes('"tool":"dynamic-catalog__getStatus"'),
    });
    t.messageIncludes("DYNAMIC_CONNECTION_FOUND");
  },
});
