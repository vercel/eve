import type { CompiledAgentManifest, CompiledToolDefinition } from "#compiler/manifest.js";
import { isInvocableCompiledTool } from "#channel/tool-eligibility.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import type { JsonObject } from "#shared/json.js";

/** One compiled tool a caller can invoke outside a turn. */
export interface AgentToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /** The tool declares an approval policy. */
  readonly approval: boolean;
}

/**
 * The caller-facing view of an agent: its name, description, and the compiled
 * tools `invokeTool` can run, sorted by name. Unlike `GET /eve/v1/info`, it
 * carries no paths, config, diagnostics, or other inspection detail, so
 * channels can publish it as is. Tools added by dynamic resolvers and
 * subagents are not listed.
 */
export interface AgentDescription {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly AgentToolDescription[];
}

/**
 * The `describe` route handler arg for one compiled agent. The artifacts
 * source resolves on first use, so routes that never call it pay nothing.
 */
export function createAgentDescriptionRouteArgs(
  resolveCompiledArtifactsSource: () => RuntimeCompiledArtifactsSource,
): { describe(): Promise<AgentDescription> } {
  return {
    async describe() {
      const compiledArtifactsSource = resolveCompiledArtifactsSource();
      return describeCompiledAgent(await loadCompiledManifest({ compiledArtifactsSource }));
    },
  };
}

/** Projects the root node of a compiled manifest onto {@link AgentDescription}. */
export function describeCompiledAgent(manifest: CompiledAgentManifest): AgentDescription {
  const tools = manifest.tools
    .filter((tool) => isInvocableCompiledTool(manifest, tool))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(describeTool);
  const description: { -readonly [K in keyof AgentDescription]: AgentDescription[K] } = {
    name: manifest.config.name,
    tools,
  };
  if (manifest.config.description !== undefined) {
    description.description = manifest.config.description;
  }
  return description;
}

function describeTool(tool: CompiledToolDefinition): AgentToolDescription {
  const description: { -readonly [K in keyof AgentToolDescription]: AgentToolDescription[K] } = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
    approval: tool.requiresApproval,
  };
  if (tool.outputSchema !== undefined) description.outputSchema = tool.outputSchema;
  return description;
}
