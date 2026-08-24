import { stripLogicalPathExtension } from "#discover/filesystem.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import type { ToolSourceRef } from "#discover/manifest.js";
import type {
  CompiledDynamicToolDefinition,
  CompiledToolDefinition,
  CompiledWebSearchProviderDefinition,
  CompiledWorkflowToolDefinition,
} from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { isKernelSpecialDefinitionPath } from "#kernel/capabilities.js";

/**
 * Compiled tool entry produced from one authored `tools/*.ts` file.
 *
 * Either a real tool definition, a `disabled` marker that removes the
 * named framework default during graph resolution, or a dynamic tool
 * resolver that produces tools at runtime.
 */
export type CompiledToolEntry =
  | { readonly kind: "tool"; readonly definition: CompiledToolDefinition }
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly kind: "workflow-tool"; readonly definition: CompiledWorkflowToolDefinition }
  | {
      readonly kind: "web-search-tool";
      readonly definition: CompiledWebSearchProviderDefinition;
    }
  | { readonly kind: "dynamic-tool"; readonly definition: CompiledDynamicToolDefinition };

/**
 * Compiles one authored tool module into the normalized tool entry
 * stored on the compiled agent manifest.
 *
 * The tool name is derived from the file path under `tools/` with the
 * extension stripped and any path separators flattened to dashes
 * (e.g. `tools/billing/refund.ts` → `"billing-refund"`). Path separators
 * cannot reach the model — most providers reject `/` in tool names — so
 * tools are the one path-derived primitive that flattens nested
 * directories into a slug-safe single segment. Authored `name` fields
 * are rejected by the normalizer.
 */
export async function compileToolEntry(
  source: ToolSourceRef,
  options: ModuleBackedDefinitionLoadOptions & { readonly name?: string },
): Promise<CompiledToolEntry> {
  const entry = normalizeToolDefinition(
    await loadModuleBackedDefinition({
      binding: options.binding,
      kind: "tool",
      moduleLoader: options.moduleLoader,
      source,
    }),
    `Expected the tool export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );
  const toolName =
    options.name ??
    stripLogicalPathExtension(source.logicalPath)
      .replace(/^tools\//, "")
      .replaceAll("/", "-");

  if (entry.kind === "disabled") {
    return { kind: "disabled", name: toolName };
  }

  if (entry.kind === "workflow-tool") {
    if (!isKernelSpecialDefinitionPath(source.logicalPath, "workflow-tool")) {
      throw new Error(
        `The experimental_workflow() definition must be exported from "tools/workflow.ts", not "${source.logicalPath}".`,
      );
    }
    return {
      kind: "workflow-tool",
      definition: {
        exportName: source.exportName,
        logicalPath: source.logicalPath,
        maxSubagents: entry.maxSubagents,
        sourceId: source.sourceId,
        sourceKind: "module",
      },
    };
  }

  if (entry.kind === "web-search-tool") {
    if (!isKernelSpecialDefinitionPath(source.logicalPath, "web-search-tool")) {
      throw new Error(
        `The webSearch() definition must be exported from "tools/web_search.ts", not "${source.logicalPath}".`,
      );
    }
    return {
      kind: "web-search-tool",
      definition: {
        exportName: source.exportName,
        logicalPath: source.logicalPath,
        provider: entry.provider,
        sourceId: source.sourceId,
        sourceKind: "module",
      },
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
      hasAuth: entry.definition.hasAuth,
      hasExecute: entry.definition.execute !== undefined,
      hasModelOutputProjection: entry.definition.hasModelOutputProjection,
      inputSchema: entry.definition.inputSchema ?? null,
      logicalPath: source.logicalPath,
      name: toolName,
      outputSchema: entry.definition.outputSchema,
      requiresApproval: entry.definition.requiresApproval,
      sourceId: source.sourceId,
      sourceKind: "module",
    },
  };
}
