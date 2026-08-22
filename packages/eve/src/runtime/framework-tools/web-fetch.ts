import { z } from "#compiled/zod/index.js";

export const WEB_FETCH_INPUT_SCHEMA = z.strictObject({
  format: z
    .enum(["markdown", "text", "html"])
    .describe(
      'The format to return the content in (text, markdown, or html). HTML responses are automatically converted to the requested format. Defaults to "markdown".',
    )
    .optional(),
  timeout: z.number().describe("Optional timeout in seconds. Defaults to 30, max 120.").optional(),
  url: z.string().describe("The fully-formed URL to fetch content from. Must start with https://."),
});

export const WEB_FETCH_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  contentType: z.string(),
  truncated: z.boolean(),
  url: z.string(),
});
