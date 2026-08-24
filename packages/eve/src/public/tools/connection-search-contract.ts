import { z } from "#compiled/zod/index.js";

export const CONNECTION_SEARCH_INPUT_SCHEMA = z.strictObject({
  connection: z
    .string()
    .describe("Optional: limit search to a specific connection name.")
    .optional(),
  keywords: z
    .string()
    .describe(
      "Search keywords and expanded aliases. Distill intent into keywords; avoid stop words like 'a', 'the', 'in'.",
    ),
  limit: z.number().describe("Max results to return. Default 10.").optional(),
});

const connectionSchema = z.looseObject({});
export const CONNECTION_SEARCH_RESULT_ITEM_SCHEMA = z.strictObject({
  connection: z.string(),
  description: z.string(),
  error: z.string().optional(),
  inputSchema: connectionSchema.optional(),
  needsAuthorization: z.boolean().optional(),
  outputSchema: connectionSchema.optional(),
  qualifiedName: z.string().optional(),
  tool: z.string().optional(),
});

export const CONNECTION_SEARCH_OUTPUT_SCHEMA = z.array(CONNECTION_SEARCH_RESULT_ITEM_SCHEMA);

export type ConnectionSearchInput = z.infer<typeof CONNECTION_SEARCH_INPUT_SCHEMA>;
export type ConnectionSearchResultItem = z.infer<typeof CONNECTION_SEARCH_RESULT_ITEM_SCHEMA>;
