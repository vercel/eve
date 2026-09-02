import { defineTool } from "eve/tools";

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const DEFAULT_AGENT_MODEL_ID = "openai/gpt-5.6-luna-fast";
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

interface GatewayModel {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly type: string;
}

export function parseGatewayModels(value: unknown): GatewayModel[] {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new Error("AI Gateway returned an invalid model catalog.");
  }
  const { data } = value;
  if (!Array.isArray(data)) throw new Error("AI Gateway returned an invalid model catalog.");

  return data.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name, tags, type } = entry;
    if (typeof id !== "string" || typeof name !== "string" || typeof type !== "string") return [];
    return [{ id, name, tags: Array.isArray(tags) ? tags.filter(isString) : [], type }];
  });
}

export function searchGatewayModels(models: readonly GatewayModel[], query: string) {
  const needle = query.trim().toLowerCase();
  return models
    .filter(
      (model) =>
        model.type === "language" &&
        (model.id === DEFAULT_AGENT_MODEL_ID || model.tags.includes("web-search")) &&
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
    "Search the list of available models. Call this to get the list of available models or to resolve a model to its exact ID.",
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
        models: searchGatewayModels(parseGatewayModels(await response.json()), input.query),
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});

function isString(value: unknown): value is string {
  return typeof value === "string";
}
