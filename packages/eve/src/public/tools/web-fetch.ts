import { z } from "#compiled/zod/index.js";

import { type WebFetchInput, executeWebFetchTool } from "#execution/web-fetch/tool.js";
import { defineTool, type ToolDefinition } from "#public/definitions/tool.js";

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

export type WebFetchToolInput = z.infer<typeof WEB_FETCH_INPUT_SCHEMA>;
export type WebFetchToolOutput = z.infer<typeof WEB_FETCH_OUTPUT_SCHEMA>;

export const webFetch: ToolDefinition<WebFetchToolInput, WebFetchToolOutput> = defineTool({
  description: [
    "Fetch a webpage and return its content in the requested format. Use this to retrieve and analyze content from URLs.",
    "",
    "Usage notes:",
    "- The URL must be a fully-formed valid URL starting with https://",
    "- HTML responses are automatically converted to markdown or plain text based on the requested format",
    '- Format options: "markdown" (default), "text", or "html"',
    "- Default timeout is 30 seconds (max 120 seconds)",
    "- Maximum response size is 5 MB; content is further capped at the shared tool-output budget (50 KB / 2000 lines)",
    "- This tool is read-only and does not modify any files",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeWebFetchTool(input as WebFetchInput, { abortSignal: ctx.abortSignal });
  },
  inputSchema: WEB_FETCH_INPUT_SCHEMA,
  outputSchema: WEB_FETCH_OUTPUT_SCHEMA,
});

export default webFetch;
