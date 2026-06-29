import { jsonSchema, type JSONSchema7, type ToolSet } from "ai";

import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
  WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA,
  WEB_SEARCH_TOOL_DEFINITION,
} from "#runtime/framework-tools/web-search.js";
import type { JsonObject } from "#shared/json.js";

/**
 * The provider backend resolved for one web search tool invocation.
 */
export type WebSearchBackend = "anthropic" | "google" | "openai" | "parallel";

/**
 * Maps an upstream provider tool type (the literal `type` string the AI SDK
 * sends to the provider) back to the framework tool name that injected it.
 *
 * Used when the AI Gateway routes a request to a fallback provider that
 * does not support a provider-specific tool — the upstream error references
 * the provider-specific type (e.g. `web_search_20250305`), but the harness
 * needs to drop the framework tool by its public name (`web_search`).
 *
 * Adding a new provider tool requires adding the corresponding mapping
 * entry here alongside its {@link resolveWebSearchProviderTool} switch
 * arm so detection stays in lockstep with injection.
 */
const UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME: Readonly<Record<string, string>> = {
  // Anthropic's stable web search tool. The Bedrock and Vertex
  // Anthropic backends reject this type because they only host the
  // older Claude Messages surface.
  web_search_20250305: WEB_SEARCH_TOOL_DEFINITION.name,
};

/**
 * Returns the framework tool name that produced an upstream provider tool
 * `type`, or `null` when the type is not one we know how to remove.
 *
 * Used by the harness recovery path to decide which tools to drop when a
 * gateway fallback provider rejects a tool. Unknown types fall through to
 * the existing terminal/recoverable handling.
 */
export function resolveFrameworkToolFromUpstreamType(type: string): string | null {
  return UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME[type] ?? null;
}

/**
 * Returns the output schema for the provider-managed web search tool that
 * will be injected for `backend`.
 */
export function resolveWebSearchOutputSchema(backend: WebSearchBackend): JsonObject {
  switch (backend) {
    case "anthropic":
      return WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA;
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
 * - All AI Gateway models: Parallel search via gateway
 * - Direct/BYO OpenAI models: native OpenAI search
 * - Direct/BYO Anthropic models: native Anthropic search
 * - Direct/BYO Google models: native Google search grounding
 * - Other BYO models: not available (returns `null`)
 */
export function resolveWebSearchBackend(modelRef: RuntimeModelReference): WebSearchBackend | null {
  if (modelRef.source === undefined) {
    return "parallel";
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
