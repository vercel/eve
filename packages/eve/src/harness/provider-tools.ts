import { jsonSchema, type JSONSchema7, type ToolSet } from "ai";

import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_EXA_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
  WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA,
} from "#kernel/web-search.js";
import type { JsonObject } from "#shared/json.js";
import type { WebSearchProvider } from "#shared/web-search.js";

/**
 * The provider backend resolved for one web search tool invocation.
 */
export type WebSearchBackend = "anthropic" | "exa" | "google" | "openai" | "parallel";

/** One model-call-scoped provider decision shared by prompt and tool stages. */
export interface ModelProviderCapabilityAvailability {
  readonly modelSupportsProviderTools: boolean;
  readonly webSearchBackend: WebSearchBackend | null;
}

export function resolveModelProviderCapabilityAvailability(
  modelRef: RuntimeModelReference,
  gatewayProvider?: WebSearchProvider,
): ModelProviderCapabilityAvailability {
  const webSearchBackend = resolveWebSearchBackend(modelRef, gatewayProvider);
  return { modelSupportsProviderTools: webSearchBackend !== null, webSearchBackend };
}

/**
 * Returns the output schema for the provider-managed web search tool that
 * will be injected for `backend`.
 */
export function resolveWebSearchOutputSchema(backend: WebSearchBackend): JsonObject {
  switch (backend) {
    case "anthropic":
      return WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA;
    case "exa":
      return WEB_SEARCH_EXA_OUTPUT_SCHEMA;
    case "google":
      return WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA;
    case "openai":
      return WEB_SEARCH_OPENAI_OUTPUT_SCHEMA;
    case "parallel":
      return WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA;
  }
}

/**
 * Determines the web search backend for a model reference.
 *
 * - All AI Gateway models: the configured search provider (Exa by default)
 * - Direct/BYO OpenAI models: native OpenAI search
 * - Direct/BYO Anthropic models: native Anthropic search
 * - Direct/BYO Google models: native Google search grounding
 * - Other BYO models: not available (returns `null`)
 */
export function resolveWebSearchBackend(
  modelRef: RuntimeModelReference,
  gatewayProvider: WebSearchProvider = "exa",
): WebSearchBackend | null {
  if (modelRef.source === undefined) {
    return gatewayProvider;
  }

  const providerId = modelRef.id.split("/")[0] ?? "";

  if (providerId === "openai" || providerId.startsWith("openai.")) {
    return "openai";
  }

  if (providerId === "anthropic" || providerId.startsWith("anthropic.")) {
    return "anthropic";
  }

  if (providerId.startsWith("google.")) {
    return "google";
  }

  return null;
}

/**
 * Constructs the AI SDK provider tool for web search based on the resolved
 * backend. Called once per harness step when web search is enabled.
 *
 * Dynamic imports keep unused provider SDKs out of the bundle — only the
 * provider matching the current model is loaded.
 */
export async function resolveWebSearchProviderTool(
  backend: WebSearchBackend,
): Promise<ToolSet[string]> {
  switch (backend) {
    case "openai": {
      const { openai } = await import("#compiled/@ai-sdk/openai/index.js");
      return attachWebSearchOutputSchema(openai.tools.webSearch({}) as ToolSet[string], backend);
    }
    case "anthropic": {
      const { anthropic } = await import("#compiled/@ai-sdk/anthropic/index.js");
      // `webSearch_20260209()` in @ai-sdk/anthropic@3.0.68 adds the
      // `code-execution-web-tools-2026-02-09` beta header, which Anthropic
      // currently rejects. Keep Anthropic web search working by using the
      // stable tool version until the upstream helper is fixed.
      return attachWebSearchOutputSchema(
        anthropic.tools.webSearch_20250305() as ToolSet[string],
        backend,
      );
    }
    case "google": {
      const { google } = await import("#compiled/@ai-sdk/google/index.js");
      return attachWebSearchOutputSchema(google.tools.googleSearch({}) as ToolSet[string], backend);
    }
    case "exa": {
      const { gateway } = await import("ai");
      return attachWebSearchOutputSchema(
        gateway.tools.exaSearch({
          contents: { highlights: { maxCharacters: 1_000 } },
          numResults: 10,
        }) as ToolSet[string],
        backend,
      );
    }
    case "parallel": {
      const { gateway } = await import("ai");
      return attachWebSearchOutputSchema(
        gateway.tools.parallelSearch() as ToolSet[string],
        backend,
      );
    }
  }
}

function attachWebSearchOutputSchema(
  tool: ToolSet[string],
  backend: WebSearchBackend,
): ToolSet[string] {
  return {
    ...tool,
    outputSchema: jsonSchema(resolveWebSearchOutputSchema(backend) as JSONSchema7),
  } as ToolSet[string];
}
