import { defineEval } from "eve/evals";
import { z } from "zod";

export default defineEval({
  description: "A compiled MCP connection projects a compact model result while retaining details.",
  async test(t) {
    await t.send(
      "Alice needs an item count from compact-catalog. Discover and call its list_items tool, then report the count.",
    );
    t.succeeded();
    t.calledTool("compact-catalog__list_items", {
      count: 1,
      output: (value) =>
        z
          .strictObject({
            content: z.array(
              z.strictObject({
                type: z.literal("text"),
                text: z.literal("CATALOG_DETAIL_OUTSIDE_MODEL_CONTEXT"),
              }),
            ),
          })
          .safeParse(value).success,
    });
    t.messageIncludes("1");
  },
});
