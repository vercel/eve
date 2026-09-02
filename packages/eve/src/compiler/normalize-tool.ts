import { stripLogicalPathExtension } from "#discover/filesystem.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import type { ToolSourceRef } from "#discover/manifest.js";
import type { CompiledToolDefinition, CompiledDynamicToolDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import type { AgentModuleBinding } from "#compiler/source-graph.js";
import { resolveAuthoredPackageRoot } from "#internal/authored-module-loader.js";
import { readAuthoredExecuteWorkflowId } from "#internal/workflow-bundle/authored-workflow-modules.js";

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
  | { readonly kind: "workflow-tool"; readonly maxSubagents?: number }
  | {
      readonly definition: CompiledToolDefinition;
      readonly kind: "web-search-tool";
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
  _agentRoot: string,
  source: ToolSourceRef,
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
      definition: {
        behavior: {
          availability: [],
          handling: { kind: "provider-tool", provider: entry.provider },
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
    return {
      kind: "dynamic-tool",
      definition: {
        eventNames: [...entry.eventNames],
        exportName: source.exportName,
        logicalPath: source.logicalPath,
        rebindMissingCallbacks: entry.rebindMissingCallbacks || undefined,
        slug: toolName,
        sourceId: source.sourceId,
        sourceKind: "module",
      },
    };
  }

  const workflowId = await readToolWorkflowId(options.binding);
  return {
    kind: "tool",
    definition: {
      behavior:
        workflowId === undefined
          ? entry.definition.behavior
          : { availability: [], handling: { kind: "workflow-tool", workflowId } },
      description: entry.definition.description,
      execution: entry.definition.execution,
      exportName: source.exportName,
      hasExecute: entry.definition.hasExecute,
      hasModelOutputProjection: entry.definition.hasModelOutputProjection,
      inputSchema: entry.definition.inputSchema ?? null,
      logicalPath: source.logicalPath,
      name: toolName,
      outputSchema: entry.definition.outputSchema,
      requiresApproval: entry.definition.hasApproval,
      sourceId: source.sourceId,
      sourceKind: "module",
    },
  };
}

async function readToolWorkflowId(binding: AgentModuleBinding): Promise<string | undefined> {
  if (binding.backing.kind !== "filesystem") return undefined;
  const filePath = binding.backing.sourcePath;
  return await readAuthoredExecuteWorkflowId({
    appRoot: resolveAuthoredPackageRoot(filePath),
    filePath,
  });
}
