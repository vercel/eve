import { stripLogicalPathExtension } from "#discover/filesystem.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledToolDefinition, CompiledDynamicToolDefinition } from "#compiler/manifest.js";
import { WEB_SEARCH_TOOL_DESCRIPTION } from "#public/tools/web-search.js";

/**
 * Compiled tool entry produced from one selected `tools/*.ts` source.
 *
 * Either a real tool definition, a `disabled` marker recorded on the node's
 * source composition, a web-search provider selection, the Workflow opt-in,
 * or a dynamic tool resolver that produces tools at runtime.
 */
export type CompiledToolEntry =
  | { readonly kind: "tool"; readonly definition: CompiledToolDefinition }
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly kind: "workflow-tool"; readonly maxSubagents?: number }
  | {
      readonly kind: "web-search-tool";
      readonly definition: CompiledToolDefinition;
      readonly provider?: "exa" | "parallel";
    }
  | { readonly kind: "dynamic-tool"; readonly definition: CompiledDynamicToolDefinition };

/**
 * Compiles one selected tool export into the normalized tool entry stored
 * on the compiled agent manifest.
 *
 * The tool name is derived from the file path under `tools/` with the
 * extension stripped and any path separators flattened to dashes
 * (e.g. `tools/billing/refund.ts` → `"billing-refund"`). Path separators
 * cannot reach the model — most providers reject `/` in tool names — so
 * tools are the one path-derived primitive that flattens nested
 * directories into a slug-safe single segment. Authored `name` fields
 * are rejected by the normalizer.
 */
export function compileToolEntry(source: ModuleSourceRef, exportValue: unknown): CompiledToolEntry {
  const entry = normalizeToolDefinition(
    exportValue,
    `Expected the tool export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );
  const toolName = deriveToolName(source.logicalPath);

  if (entry.kind === "disabled") {
    return { kind: "disabled", name: toolName };
  }

  if (entry.kind === "workflow-tool") {
    return { kind: "workflow-tool", maxSubagents: entry.maxSubagents };
  }

  if (entry.kind === "web-search-tool") {
    if (toolName !== "web_search") {
      throw new Error(
        `The webSearch() definition must be exported from "tools/web_search.ts", not "${source.logicalPath}".`,
      );
    }
    return {
      kind: "web-search-tool",
      definition: {
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        exportName: source.exportName,
        inputSchema: null,
        logicalPath: source.logicalPath,
        name: toolName,
        sourceId: source.sourceId,
        sourceKind: "module",
      },
      provider: entry.provider,
    };
  }

  if (entry.kind === "dynamic-tool") {
    return {
      kind: "dynamic-tool",
      definition: {
        eventNames: [...entry.eventNames],
        exportName: source.exportName,
        logicalPath: source.logicalPath,
        slug: toolName,
        sourceId: source.sourceId,
        sourceKind: "module",
      },
    };
  }

  return {
    kind: "tool",
    definition: {
      description: entry.definition.description,
      execution: entry.definition.execution,
      exportName: source.exportName,
      inputSchema: entry.definition.inputSchema ?? null,
      logicalPath: source.logicalPath,
      name: toolName,
      outputSchema: entry.definition.outputSchema,
      sourceId: source.sourceId,
      sourceKind: "module",
    },
  };
}

/** Derives the model-visible tool name from one `tools/**` logical path. */
export function deriveToolName(logicalPath: string): string {
  return stripLogicalPathExtension(logicalPath)
    .replace(/^tools\//, "")
    .replaceAll("/", "-");
}
