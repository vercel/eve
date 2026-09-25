import { type WebFetchInput, executeWebFetchTool } from "#execution/web-fetch/execute.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface WebFetchToolInput {
  format?: "markdown" | "text" | "html";
  timeout?: number;
  url: string;
}

export interface WebFetchToolOutput {
  content: string;
  contentType: string;
  truncated: boolean;
  url: string;
}

export const WEB_FETCH_INPUT_SCHEMA = defineJsonSchema<WebFetchToolInput>({
  type: "object",
  properties: {
    format: {
      type: "string",
      enum: ["markdown", "text", "html"],
      description:
        'The format to return the content in (text, markdown, or html). HTML responses are automatically converted to the requested format. Defaults to "markdown".',
    },
    timeout: {
      type: "number",
      description: "Optional timeout in seconds. Defaults to 30, max 120.",
    },
    url: {
      type: "string",
      description: "The fully-formed URL to fetch content from. Must start with https://.",
    },
  },
  required: ["url"],
  additionalProperties: false,
});

export const WEB_FETCH_OUTPUT_SCHEMA = defineJsonSchema<WebFetchToolOutput>({
  type: "object",
  properties: {
    content: { type: "string" },
    contentType: { type: "string" },
    truncated: { type: "boolean" },
    url: { type: "string" },
  },
  required: ["content", "contentType", "truncated", "url"],
  additionalProperties: false,
});

export const webFetch: ToolDefinition<WebFetchToolInput, WebFetchToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Fetch", input.url) },
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
