import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Look up one query or a batch of queries. Provide exactly one of query or queries. Only call when explicitly asked to use lookup-scope.",
  inputSchema: z
    .object({ query: z.string().optional(), queries: z.array(z.string()).optional() })
    .refine(
      (input) => Number(input.query !== undefined) + Number(input.queries !== undefined) === 1,
      "Provide exactly one of query or queries.",
    ),
  execute(input) {
    return { requested: input.query === undefined ? input.queries : [input.query] };
  },
});
