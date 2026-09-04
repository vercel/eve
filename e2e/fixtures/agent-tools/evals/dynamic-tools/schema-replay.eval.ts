import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Dynamic schemas reject lossy validation and durable executors retain normalization.",
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip(
        "Requires the deterministic mock model to inspect available tools and send exact whitespace.",
      );
      return;
    }

    const first = await t.send("Run the schema replay regression with accepted input.");
    first.expectOk();
    first.calledTool("normalize_dynamic", { output: { value: "accepted" } });

    const replayed = await t.send("Run the schema replay regression again with accepted input.");
    replayed.expectOk();
    replayed.calledTool("normalize_dynamic", { output: { value: "accepted" } });

    const rejected = await t.send("Run the schema replay regression with whitespace input.");
    rejected.expectOk();
    rejected.calledTool("normalize_dynamic", { status: "failed" });

    t.notCalledTool("invalid_dynamic_schema");
    t.succeeded();
  },
});
