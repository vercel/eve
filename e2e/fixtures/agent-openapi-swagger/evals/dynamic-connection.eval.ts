import { defineEval } from "eve/evals";

export default defineEval({
  description: "A session-scoped dynamic OpenAPI connection participates in connection_search.",

  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic mock model; the fixture API endpoint is non-routable.");
    }

    await t.send("DYNAMIC_CONNECTION_E2E");

    t.succeeded();
    t.toolOrder(["connection_search"]);
    t.calledTool("connection_search", { count: 1, output: hasDynamicStatusTool });
    t.messageIncludes("DYNAMIC_CONNECTION_FOUND");
  },
});

function hasDynamicStatusTool(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Reflect.get(entry, "connection") === "dynamic-catalog" &&
        Reflect.get(entry, "qualifiedName") === "dynamic-catalog__getStatus",
    )
  );
}
