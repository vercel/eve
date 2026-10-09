import { jsonSchema, type JSONSchema7, type ToolSet } from "ai";

import type { ModelProfile } from "#harness/model-profile.js";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_EXA_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
  WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA,
  WEB_SEARCH_TOOL_NAME,
} from "#harness/provider-tool-schemas.js";
import type { JsonObject } from "#shared/json.js";
import type { WebSearchSelection } from "#shared/web-search.js";

/**
 * The provider backend resolved for one web search tool invocation.
 */
type WebSearchBackend = "anthropic" | "exa" | "google" | "openai" | "parallel" | "browserbase";

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
  web_search_20250305: WEB_SEARCH_TOOL_NAME,
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
export function resolveWebSearchOutputSchema(
  backend: Exclude<WebSearchBackend, "browserbase">,
): JsonObject {
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
 * Determines the web search backend for a model. On AI Gateway it is the selected search
 * provider (Exa by default); `native` selects the model vendor's own search, or the fallback
 * when the model has none. Direct models always use their provider's native search. A model
 * left without a backend gets none (`null`).
 */
export function resolveWebSearchBackend(
  profile: ModelProfile,
  selection: WebSearchSelection = { provider: "exa" },
): WebSearchBackend | null {
  if (!profile.gateway) return resolveNativeWebSearchBackend(profile);
  if (selection.provider !== "native") return selection.provider;
  return resolveNativeWebSearchBackend(profile) ?? selection.fallback ?? null;
}

function resolveNativeWebSearchBackend(profile: ModelProfile): NativeWebSearchBackend | null {
  if (!NATIVE_WEB_SEARCH_BACKENDS.has(profile.provider)) return null;
  if (profile.provider === "google" && profile.googleSearchDropsTools) return null;
  return profile.provider as NativeWebSearchBackend;
}

type NativeWebSearchBackend = "anthropic" | "google" | "openai";

const NATIVE_WEB_SEARCH_BACKENDS: ReadonlySet<string> = new Set<NativeWebSearchBackend>([
  "anthropic",
  "google",
  "openai",
]);

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
    case "browserbase": {
      const { gateway } = await import("ai");
      return gateway.tools.browserbaseSearch();
    }
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
  backend: Exclude<WebSearchBackend, "browserbase">,
): ToolSet[string] {
  return {
    ...tool,
    outputSchema: jsonSchema(resolveWebSearchOutputSchema(backend) as JSONSchema7),
  } as ToolSet[string];
}
