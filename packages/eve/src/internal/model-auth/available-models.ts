import { isObject } from "#shared/guards.js";
import { getDefaultCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
import { authJson } from "./vercel.js";
import { resolveModelApiKey } from "./transport.js";

const MODEL_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

export async function availableDirectModels(
  provider: "openai" | "anthropic",
  key: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const value = await authJson(
    provider === "openai"
      ? "https://api.openai.com/v1/models"
      : "https://api.anthropic.com/v1/models?limit=1000",
    {
      headers:
        provider === "openai"
          ? { authorization: `Bearer ${key}` }
          : { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal,
    },
    MODEL_CATALOG_MAX_BYTES,
  );
  if (!Array.isArray(value.data))
    throw new Error("The provider could not validate this key. Check it and retry /login.");
  return value.data.flatMap((model) =>
    isObject(model) && typeof model.id === "string" ? [model.id] : [],
  );
}

export async function availableHelperModels(
  provider: "openai" | "anthropic" | "chatgpt",
  signal?: AbortSignal,
): Promise<string[]> {
  if (provider !== "chatgpt")
    return availableDirectModels(provider, await resolveModelApiKey(provider), signal);
  const token = await getDefaultCodexTokenBroker().getToken({ reason: "request" });
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.token}`,
    originator: "eve",
  };
  if (token.accountId) headers["ChatGPT-Account-Id"] = token.accountId;
  const value = await authJson(
    "https://chatgpt.com/backend-api/codex/models?client_version=0.148.0",
    { headers, signal },
    MODEL_CATALOG_MAX_BYTES,
  );
  if (!Array.isArray(value.models))
    throw new Error("Could not load ChatGPT models. Check your connection and retry /login.");
  return value.models.flatMap((model) =>
    isObject(model) && typeof model.slug === "string" && model.visibility !== "hide"
      ? [model.slug]
      : [],
  );
}
