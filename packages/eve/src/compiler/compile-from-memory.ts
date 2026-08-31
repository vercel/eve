import { randomUUID } from "node:crypto";

import type { JsonObject } from "#shared/json.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { defineAgent, type AgentDefinition } from "#public/definitions/agent.js";
import { defineSkill } from "#public/definitions/skill.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createProgrammaticCompiledModuleMap,
  type CompiledModuleMap,
} from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  type ProgrammaticAgentModule,
} from "#compiler/source-graph.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";

export interface CompileFromMemoryInput {
  readonly agent?: AgentDefinition;
  readonly name?: string;
  readonly appRoot?: string;
  readonly agentRoot?: string;
  readonly model: string;
  readonly limits?: {
    readonly maxInputTokensPerSession?: number | false;
    readonly maxOutputTokensPerSession?: number | false;
    readonly sessionTimeoutMs?: number | false;
  };
  readonly outputSchema?: JsonObject;
  readonly revision?: string;
  readonly modules?: readonly ProgrammaticAgentModule[];
  readonly tools?: readonly CompileFromMemoryToolInput[];
  readonly skills?: readonly CompileFromMemorySkillInput[];
}

export interface CompileFromMemoryToolInput {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject | null;
  readonly outputSchema?: JsonObject;
  readonly execute?: ToolDefinition["execute"];
  readonly approval?: ToolDefinition["approval"];
  readonly toModelOutput?: ToolDefinition["toModelOutput"];
}

export interface CompileFromMemorySkillInput {
  readonly name: string;
  readonly description: string;
  readonly markdown?: string;
}

export interface CompileFromMemoryResult {
  readonly manifest: CompiledAgentManifest;
  readonly moduleMap: CompiledModuleMap;
}

/** Compiles a synthetic application by registering one ordinary programmatic source. */
export async function compileFromMemory(
  input: CompileFromMemoryInput,
): Promise<CompileFromMemoryResult> {
  const appRoot = input.appRoot ?? "/virtual/eve-memory-app";
  const agentRoot = input.agentRoot ?? `${appRoot}/agent`;
  const sourceId = `memory:${input.name ?? "memory-agent"}`;
  const config = defineAgent(
    input.agent ?? {
      limits: input.limits,
      model: input.model,
      outputSchema: input.outputSchema,
    },
  );
  const modules = [
    {
      loadNamespace: async () => ({ default: config }),
      logicalPath: "agent.ts",
    },
    ...(input.modules ?? []),
    ...(input.tools ?? []).map((tool) => ({
      loadNamespace: async () => ({ default: createMemoryToolDefinition(tool) }),
      logicalPath: `tools/${tool.name}.ts`,
    })),
    ...(input.skills ?? []).map((skill) => ({
      loadNamespace: async () => ({
        default: defineSkill({
          description: skill.description,
          markdown: skill.markdown ?? `# ${skill.name}\n`,
        }),
      }),
      logicalPath: `skills/${skill.name}.ts`,
    })),
  ];
  const registry = createAgentSourceRegistry([
    {
      applyTo: "root",
      source: defineProgrammaticAgentSource({
        id: sourceId,
        modules,
        revision: input.revision ?? `memory-generation:${randomUUID()}`,
      }),
    },
  ]);
  const discovered = createAgentSourceManifest({
    agentId: input.name ?? "memory-agent",
    agentRoot,
    appRoot,
  });
  const manifest = await compileAgentManifest(discovered, { sourceRegistries: [registry] });
  const moduleMap = await createProgrammaticCompiledModuleMap(manifest, [
    frameworkAgentSourceRegistry,
    registry,
  ]);
  return { manifest, moduleMap };
}

function createMemoryToolDefinition(input: CompileFromMemoryToolInput): ToolDefinition {
  return defineTool({
    approval: input.approval,
    description: input.description ?? `${input.name} test tool.`,
    execute:
      input.execute ??
      (() => {
        throw new Error(`Memory tool "${input.name}" has no installed executor.`);
      }),
    inputSchema: input.inputSchema ?? { additionalProperties: true, type: "object" },
    outputSchema: input.outputSchema,
    toModelOutput: input.toModelOutput,
  });
}
