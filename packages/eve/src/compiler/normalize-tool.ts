import { stripLogicalPathExtension } from "#discover/filesystem.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledDefinition, CompiledToolDefinition } from "#compiler/manifest.js";
import {
  compiledDefinition,
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import { WEB_SEARCH_TOOL_DESCRIPTION } from "#tools/provided/web-search.js";

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
  | {
      readonly definition: CompiledToolDefinition;
      readonly kind: "web-search-tool";
    }
  | { readonly kind: "dynamic"; readonly definition: CompiledDefinition };

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
  _agentRoot: string,
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledToolEntry> {
  const entry = normalizeToolDefinition(
    await loadModuleBackedDefinition({
      binding: options.binding,
      kind: "tool",
      loadNamespace: options.loadNamespace,
      source,
    }),
    `Expected the tool export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );
  const toolName = stripLogicalPathExtension(source.logicalPath)
    .replace(/^tools\//, "")
    .replaceAll("/", "-");

  // Checked before a disabled tool returns: a runtime tool can't be disabled either.
  const reservation = eveNamespaceReservation(toolName);
  if (reservation !== undefined) {
    throw new Error(
      `Tool "${source.logicalPath}" uses the reserved name "${toolName}". Rename its path; ${reservation}.`,
    );
  }

  if (entry.kind === "disabled") {
    return { kind: "disabled", name: toolName };
  }

  if (entry.kind === "web-search-tool") {
    if (toolName !== "web_search") {
      throw new Error(
        `The webSearch() definition must be exported from "tools/web_search.ts", not "${source.logicalPath}".`,
      );
    }
    return {
      definition: {
        behavior: {
          availability: [],
          handling: { kind: "provider-tool", ...entry.selection },
        },
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        exportName: source.exportName,
        hasExecute: false,
        hasModelOutputProjection: false,
        inputSchema: null,
        logicalPath: source.logicalPath,
        name: toolName,
        sourceId: source.sourceId,
        sourceKind: "module",
        requiresApproval: false,
      },
      kind: "web-search-tool",
    };
  }

  if (entry.kind === "dynamic-tool") {
    return { definition: compiledDefinition("tool", source, toolName), kind: "dynamic" };
  }

  const { workflow } = entry.definition;
  const shape = {
    suspend: workflow === undefined ? ("none" as const) : ("workflow" as const),
  };
  return {
    kind: "tool",
    definition: {
      availableInSubagents: entry.definition.availableInSubagents,
      deferred: entry.definition.deferred,
      behavior:
        workflow === undefined
          ? entry.definition.behavior === undefined
            ? { availability: [], shape }
            : { ...entry.definition.behavior, shape }
          : { availability: [], handling: { kind: "workflow-tool", ...workflow }, shape },
      description: entry.definition.description,
      exportName: source.exportName,
      hasExecute: entry.definition.hasExecute,
      hasModelOutputProjection: entry.definition.hasModelOutputProjection,
      inputSchema: entry.definition.inputSchema ?? null,
      logicalPath: source.logicalPath,
      modelInputSchema: entry.definition.modelInputSchema,
      name: toolName,
      outputSchema: entry.definition.outputSchema,
      requiresApproval: entry.definition.hasApproval,
      sourceId: source.sourceId,
      sourceKind: "module",
      workflowProgram: entry.definition.workflowProgram,
    },
  };
}
