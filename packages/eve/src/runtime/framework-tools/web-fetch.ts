import { z } from "#compiled/zod/index.js";

import { executeWebFetchTool, type WebFetchInput } from "#execution/web-fetch/tool.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

async function executeWebFetch(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeWebFetchTool(input as WebFetchInput, { abortSignal: options?.abortSignal });
}

export const WEB_FETCH_INPUT_SCHEMA = z.strictObject({
  format: z
    .enum(["markdown", "text", "html"])
    .describe(
      'The format to return the content in (text, markdown, or html). HTML responses are automatically converted to the requested format. Defaults to "markdown".',
    )
    .optional(),
  timeout: z.number().describe("Optional timeout in seconds. Defaults to 30, max 120.").optional(),
  url: z
    .string()
    .describe("The fully-formed URL to fetch content from. Must start with http:// or https://."),
});

export const WEB_FETCH_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  contentType: z.string(),
  truncated: z.boolean(),
  url: z.string(),
});

export const WEB_FETCH_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Fetch a webpage and return its content in the requested format. Use this to retrieve and analyze content from URLs.",
    "",
    "Usage notes:",
    "- The URL must be a fully-formed valid URL starting with http:// or https://",
    "- HTML responses are automatically converted to markdown or plain text based on the requested format",
    '- Format options: "markdown" (default), "text", or "html"',
    "- Default timeout is 30 seconds (max 120 seconds)",
    "- Maximum response size is 5 MB; content is further capped at the shared tool-output budget (50 KB / 2000 lines)",
    "- This tool is read-only and does not modify any files",
  ].join("\n"),
  execute: executeWebFetch,
  inputSchema: WEB_FETCH_INPUT_SCHEMA,
  logicalPath: "eve:framework/web-fetch",
  name: "web_fetch",
  outputSchema: WEB_FETCH_OUTPUT_SCHEMA,
  sourceId: "eve:web-fetch-tool",
  sourceKind: "module",
};
