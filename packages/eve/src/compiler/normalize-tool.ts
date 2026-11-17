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

export type CompiledToolEntry =
  | { readonly kind: "tool"; readonly definition: CompiledToolDefinition }
  | { readonly kind: "disabled"; readonly name: string }
  | {
      readonly definition: CompiledToolDefinition;
      readonly kind: "web-search-tool";
    }
  | { readonly kind: "dynamic"; readonly definition: CompiledDefinition };

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
        description:
          "Search the web for real-time information. Use this to find up-to-date information about current events, recent developments, or topics that may have changed since the knowledge cutoff.",
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
