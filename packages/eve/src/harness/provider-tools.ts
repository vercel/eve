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

type WebSearchBackend =
  | "anthropic"
  | "exa"
  | "google"
  | "openai"
  | "parallel"
  | GatewaySchemaBackend;

type GatewaySchemaBackend = "browserbase" | "tako";

const UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME: Readonly<Record<string, string>> = {
  web_search_20250305: WEB_SEARCH_TOOL_NAME,
  web_search: WEB_SEARCH_TOOL_NAME,
  web_search_tool_result: WEB_SEARCH_TOOL_NAME,
  "web_search_call.action.sources": WEB_SEARCH_TOOL_NAME,
};

export function resolveFrameworkToolFromUpstreamType(type: string): string | null {
  return UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME[type] ?? null;
}

export function resolveWebSearchOutputSchema(
  backend: Exclude<WebSearchBackend, GatewaySchemaBackend>,
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

export function resolveWebSearchBackend(
  profile: ModelProfile,
  selection: WebSearchSelection = { provider: "parallel" },
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

export async function resolveWebSearchProviderTool(
  backend: WebSearchBackend,
): Promise<ToolSet[string]> {
  switch (backend) {
    case "browserbase": {
      const { gateway } = await import("ai");
      return gateway.tools.browserbaseSearch();
    }
    case "tako": {
      const { gateway } = await import("ai");
      return gateway.tools.takoSearch();
    }
    case "openai": {
      const { openai } = await import("#compiled/@ai-sdk/openai/index.js");
      return attachWebSearchOutputSchema(openai.tools.webSearch({}) as ToolSet[string], backend);
    }
    case "anthropic": {
      const { anthropic } = await import("#compiled/@ai-sdk/anthropic/index.js");
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
  backend: Exclude<WebSearchBackend, GatewaySchemaBackend>,
): ToolSet[string] {
  return {
    ...tool,
    outputSchema: jsonSchema(resolveWebSearchOutputSchema(backend) as JSONSchema7),
  } as ToolSet[string];
}
