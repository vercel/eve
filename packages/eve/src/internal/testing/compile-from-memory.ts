import { randomUUID } from "node:crypto";

import type { JsonObject } from "#shared/json.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { defineAgent, type AgentDefinition } from "#public/definitions/agent.js";
import { defineSkill } from "#public/definitions/skill.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import type { CompiledAgentManifest, CompiledSkillDefinition } from "#compiler/manifest.js";
import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import type { ModelMetadata } from "#internal/model-catalog.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/module-map.js";
import type { CompiledModuleMap } from "#compiler/module-map-schema.js";
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
  readonly limits?: import("#shared/agent-definition.js").AgentLimitsDefinition;
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
  readonly label?: ToolDefinition["label"];
  readonly approval?: ToolDefinition["approval"];
  readonly toModelOutput?: ToolDefinition["toModelOutput"];
}

export interface CompileFromMemorySkillInput {
  readonly name: string;
  readonly description: string;
  readonly markdown?: string;
}

interface CompileFromMemoryResult {
  readonly manifest: CompiledAgentManifest;
  readonly modelMetadata: ModelMetadata;
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
          content: skill.markdown ?? `# ${skill.name}\n`,
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
  const modelCatalog = createCompiledRuntimeModelCatalogLoader(appRoot);
  const manifest = withoutSkillFiles(
    await compileAgentManifest(discovered, { modelCatalog, sourceRegistries: [registry] }),
  );
  const moduleMap = await createProgrammaticCompiledModuleMap(manifest, [
    frameworkAgentSourceRegistry,
    registry,
  ]);
  return { manifest, modelMetadata: await modelCatalog.loadModelMetadata(), moduleMap };
}

function createMemoryToolDefinition(input: CompileFromMemoryToolInput): ToolDefinition {
  return defineTool({
    label: input.label,
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

// A build writes a skill's sibling files into the workspace resources a sandbox seeds, and keeps
// them out of the manifest. Memory has no such resources, so the files stay unwritten; the
// skill's content still lists and loads.
function withoutSkillFiles(manifest: CompiledAgentManifest): CompiledAgentManifest {
  return {
    ...stripSkillFiles(manifest),
    subagents: manifest.subagents.map((subagent) =>
      subagent.configResolver === undefined
        ? { ...subagent, agent: stripSkillFiles(subagent.agent) }
        : {
            ...subagent,
            agent: stripSkillFiles(subagent.agent),
            configResolver: subagent.configResolver,
          },
    ),
  };
}

function stripSkillFiles<T extends { readonly skills: readonly CompiledSkillDefinition[] }>(
  node: T,
): T {
  return { ...node, skills: node.skills.map(({ files: _files, ...skill }) => skill) };
}
