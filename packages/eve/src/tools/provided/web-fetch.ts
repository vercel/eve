import { type WebFetchInput, executeWebFetchTool } from "#execution/web-fetch/execute.js";
import { toolOutput, type ToolModelOutput } from "#tools/model-output.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

/**
 * Input to the provided `web_fetch` tool: the `https:` URL to fetch, the format to return, and a
 * timeout in seconds.
 */
export interface WebFetchToolInput {
  format?: "markdown" | "text" | "html";
  timeout?: number;
  url: string;
}

/**
 * Result of the provided `web_fetch` tool: the fetched content, its content type, the URL, and
 * whether the content was truncated.
 */
export interface WebFetchToolOutput {
  content: string;
  contentType: string;
  truncated: boolean;
  url: string;
}

export const WEB_FETCH_INPUT_SCHEMA = defineJsonSchema<WebFetchToolInput>(
  {
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
        description: "Optional timeout in seconds, greater than 0. Defaults to 30, max 120.",
      },
      url: {
        type: "string",
        description: "The fully-formed URL to fetch content from. Must start with https://.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  (input) =>
    input.timeout !== undefined && !(input.timeout > 0)
      ? "timeout must be greater than 0 seconds."
      : undefined,
);

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

/**
 * The provided `web_fetch` tool, which lets the agent fetch an `https:` URL and read its content as
 * Markdown, plain text, or HTML.
 */
export const webFetch: ToolDefinition<WebFetchToolInput, WebFetchToolOutput> = frameworkTool(
  defineTool({
    label: { start: (input) => toolLabel("Fetch", input.url) },
    description:
      "Fetch an `https://` URL and return its content as markdown, text, or html (max 5 MB response, capped at 50 KB / 2000 lines).",
    async execute(input, ctx) {
      return await executeWebFetchTool(input as WebFetchInput, { abortSignal: ctx.abortSignal });
    },
    inputSchema: WEB_FETCH_INPUT_SCHEMA,
    outputSchema: WEB_FETCH_OUTPUT_SCHEMA,
    toModelOutput: webFetchModelOutput,
  }),
);

const WEB_FETCH_OUTPUT_KEYS = new Set(["content", "contentType", "truncated", "url"]);

function webFetchModelOutput(output: unknown): ToolModelOutput {
  if (typeof output === "string") return toolOutput.text(output);
  if (isWebFetchResult(output)) {
    return toolOutput.text(output.truncated ? `${output.content}\n[truncated]` : output.content);
  }
  return toolOutput.json(output);
}

function isWebFetchResult(output: unknown): output is WebFetchToolOutput {
  if (typeof output !== "object" || output === null) return false;
  const value = output as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => WEB_FETCH_OUTPUT_KEYS.has(key)) &&
    typeof value.content === "string" &&
    typeof value.contentType === "string" &&
    typeof value.truncated === "boolean" &&
    typeof value.url === "string"
  );
}

export default webFetch;
import { frameworkTool } from "./framework-tool.js";
