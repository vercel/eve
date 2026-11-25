import { asSchema, type ToolSet } from "ai";

import type { HarnessModelMessage } from "#harness/messages.js";
import { isObject } from "#shared/guards.js";
import { loadedToolNames } from "#shared/openai-additional-tools.js";
import type { JsonObject } from "#shared/json.js";
import { awaitsProviderToolResult } from "#shared/provider-tool-history.js";

function isFunctionTool(tool: ToolSet[string]): boolean {
  return tool.type === undefined || tool.type === "function";
}

const SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "dependencies",
  "patternProperties",
  "properties",
] as const;
const SCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "not",
  "then",
] as const;
const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "items", "oneOf"] as const;

function hasRegexLookaround(pattern: string): boolean {
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (!inClass && character === "(" && pattern[index + 1] === "?") {
      const next = pattern[index + 2];
      if (next === "=" || next === "!") return true;
      if (next === "<" && (pattern[index + 3] === "=" || pattern[index + 3] === "!")) return true;
    }
  }
  return false;
}

export function withoutUnsupportedKeywords(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const node: Record<string, unknown> = { ...schema };
  delete node.propertyNames;
  if (typeof node.pattern === "string" && hasRegexLookaround(node.pattern)) delete node.pattern;
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = node[keyword];
    if (!isObject(map)) continue;
    node[keyword] = Object.fromEntries(
      Object.entries(map).map(([name, value]) => [
        name,
        Array.isArray(value) ? value : withoutUnsupportedKeywords(value),
      ]),
    );
  }
  for (const keyword of SCHEMA_KEYWORDS) {
    if (node[keyword] !== undefined) node[keyword] = withoutUnsupportedKeywords(node[keyword]);
  }
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    const value = node[keyword];
    if (Array.isArray(value)) node[keyword] = value.map(withoutUnsupportedKeywords);
    else if (keyword === "items" && value !== undefined)
      node[keyword] = withoutUnsupportedKeywords(value);
  }
  return node;
}

async function definitionOf(name: string, tool: ToolSet[string]): Promise<JsonObject> {
  return {
    type: "function",
    name,
    ...(typeof tool.description === "string" && { description: tool.description }),
    parameters: withoutUnsupportedKeywords(
      await asSchema(tool.inputSchema).jsonSchema,
    ) as JsonObject,
    ...(tool.strict !== undefined && { strict: tool.strict }),
  };
}

function omittedFromRequest(tool: ToolSet[string]): ToolSet[string] {
  return {
    ...tool,
    providerOptions: {
      ...tool.providerOptions,
      openai: { ...tool.providerOptions?.openai, omitFromRequestTools: true },
    },
  };
}

export interface RequestTools {
  readonly loads: readonly HarnessModelMessage[];
  readonly names: readonly string[];
  readonly tools: ToolSet;
}

export async function fixRequestTools(input: {
  readonly fixed: readonly string[] | undefined;
  readonly history: readonly HarnessModelMessage[];
  readonly tools: ToolSet;
}): Promise<RequestTools> {
  const { history, tools } = input;
  const names = input.fixed ?? Object.keys(tools);
  const fixed = new Set(names);
  const loaded = loadedToolNames(history);
  const awaiting = awaitsProviderToolResult(history);
  const pending: JsonObject[] = [];
  const result: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (fixed.has(name) || !isFunctionTool(tool)) {
      result[name] = tool;
      continue;
    }
    result[name] = omittedFromRequest(tool);
    if (!loaded.has(name) && !awaiting) pending.push(await definitionOf(name, tool));
  }
  const loads: HarnessModelMessage[] =
    pending.length === 0
      ? []
      : [
          {
            role: "system",
            content: "",
            providerOptions: { openai: { additionalTools: pending } },
          },
        ];
  return { loads, names, tools: result };
}
