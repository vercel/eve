import { defineTool } from "eve/tools";

import { AI_GATEWAY_MODELS_URL } from "#internal/gateway.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import {
  parseGatewayModelCatalog,
  type GatewayCatalogModel,
} from "#shared/gateway-model-catalog.js";
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESULTS = 20;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "A full model ID, model name, or short name such as 'luna'.",
    },
  },
  required: ["query"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          provider: { type: "string" },
        },
        required: ["id", "name", "provider"],
      },
    },
  },
  required: ["models"],
} as const;

export function searchGatewayModels(models: readonly GatewayCatalogModel[], query: string) {
  const needle = query.trim().toLowerCase();
  return models
    .filter(
      (model) =>
        model.type === "language" &&
        (model.id === DEFAULT_AGENT_MODEL_ID || model.tags?.includes("web-search")) &&
        (model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)),
    )
    .slice(0, MAX_RESULTS)
    .map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.id.split("/")[0] ?? "",
    }));
}

export default defineTool({
  description:
    "Search the Vercel AI Gateway model catalog. Call this to list available AI Gateway models or resolve a model to its exact ID.",
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    if (typeof input.query !== "string") throw new Error("Expected a model search query.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const signal = AbortSignal.any([ctx.abortSignal, controller.signal]);
      const response = await fetch(AI_GATEWAY_MODELS_URL, { signal });
      if (!response.ok) {
        throw new Error(`AI Gateway model catalog request failed (${response.status}).`);
      }
      return {
        models: searchGatewayModels(parseGatewayModelCatalog(await response.json()), input.query),
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
