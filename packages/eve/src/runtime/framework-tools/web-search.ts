import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Output schema for OpenAI's provider-managed `webSearch` tool.
 */
export const WEB_SEARCH_OPENAI_OUTPUT_SCHEMA: JsonObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  additionalProperties: false,
  properties: {
    action: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            queries: {
              items: { type: "string" },
              type: "array",
            },
            query: { type: "string" },
            type: {
              const: "search",
              type: "string",
            },
          },
          required: ["type"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: {
            type: {
              const: "openPage",
              type: "string",
            },
            url: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
          required: ["type"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: {
            pattern: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            type: {
              const: "findInPage",
              type: "string",
            },
            url: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
          required: ["type"],
          type: "object",
        },
      ],
    },
    sources: {
      items: {
        oneOf: [
          {
            additionalProperties: false,
            properties: {
              type: {
                const: "url",
                type: "string",
              },
              url: { type: "string" },
            },
            required: ["type", "url"],
            type: "object",
          },
          {
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              type: {
                const: "api",
                type: "string",
              },
            },
            required: ["type", "name"],
            type: "object",
          },
        ],
      },
      type: "array",
    },
  },
  type: "object",
};

/**
 * Output schema for Anthropic's stable provider-managed `webSearch_20250305` tool.
 */
export const WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA: JsonObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  items: {
    additionalProperties: false,
    properties: {
      encryptedContent: { type: "string" },
      pageAge: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      title: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      type: {
        const: "web_search_result",
        type: "string",
      },
      url: { type: "string" },
    },
    required: ["url", "title", "pageAge", "encryptedContent", "type"],
    type: "object",
  },
  type: "array",
};

/**
 * Output schema for Google's provider-managed `googleSearch` grounding tool.
 */
export const WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA: JsonObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  additionalProperties: false,
  properties: {},
  type: "object",
};

/**
 * Output schema for AI Gateway's provider-managed `perplexitySearch` tool.
 */
export const WEB_SEARCH_GATEWAY_OUTPUT_SCHEMA: JsonObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  anyOf: [
    {
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        results: {
          items: {
            additionalProperties: false,
            properties: {
              date: { type: "string" },
              lastUpdated: { type: "string" },
              snippet: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
            },
            required: ["title", "url", "snippet"],
            type: "object",
          },
          type: "array",
        },
      },
      required: ["results", "id"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        error: {
          enum: ["api_error", "rate_limit", "timeout", "invalid_input", "unknown"],
          type: "string",
        },
        message: { type: "string" },
        statusCode: { type: "number" },
      },
      required: ["error", "message"],
      type: "object",
    },
  ],
};

/**
 * Framework-provided web search tool definition.
 *
 * Omits `execute` — the execution layer skips executor creation for tools
 * without it, and the harness injects the real provider-managed tool at
 * step time.
 */
export const WEB_SEARCH_TOOL_DEFINITION: ResolvedToolDefinition = {
  description:
    "Search the web for real-time information. Use this to find up-to-date information about current events, recent developments, or topics that may have changed since the knowledge cutoff.",
  inputSchema: null,
  logicalPath: "eve:framework/web-search",
  name: "web_search",
  sourceId: "eve:web-search-tool",
  sourceKind: "module",
};
