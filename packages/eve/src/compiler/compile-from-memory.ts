import type { JsonObject } from "#shared/json.js";
import type { SkillFileContent } from "#public/definitions/skill.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import {
  createAgentSourceRegistry,
  type AgentSourceRegistry,
} from "#compiler/agent-source-registry.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createProgrammaticCompiledModuleMap,
  type CompiledModuleMap,
} from "#compiler/module-map.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";

const MEMORY_APPLICATION_SOURCE_ID = "eve-memory-application";
const MEMORY_MODEL_LIMITS = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 32_000,
} as const;

/** Declarative description of an in-memory authored agent used by tests. */
export interface CompileFromMemoryInput {
  /** Identifies this synthetic agent in manifest metadata and error output. */
  readonly name?: string;
  /** Virtual app root. No files need to exist beneath it. */
  readonly appRoot?: string;
  /** Virtual agent root. Defaults to `<appRoot>/agent`. */
  readonly agentRoot?: string;
  /** Model id authored by the synthetic `agent.ts`. */
  readonly model: string;
  readonly limits?: {
    readonly maxInputTokensPerSession?: number | false;
    readonly maxOutputTokensPerSession?: number | false;
    readonly sessionTimeoutMs?: number | false;
  };
  readonly outputSchema?: JsonObject;
  readonly tools?: readonly CompileFromMemoryToolInput[];
  readonly skills?: readonly CompileFromMemorySkillInput[];
}

/** One ordinary `tools/<name>.ts` module in the in-memory application source. */
export interface CompileFromMemoryToolInput {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject | null;
  readonly outputSchema?: JsonObject;
  readonly execute?: ResolvedToolDefinition["execute"];
  readonly execution?: ResolvedToolDefinition["execution"];
  readonly approval?: ResolvedToolDefinition["approval"];
  readonly toModelOutput?: ResolvedToolDefinition["toModelOutput"];
}

/** One ordinary `skills/<name>.ts` module in the in-memory application source. */
export interface CompileFromMemorySkillInput {
  readonly name: string;
  readonly description: string;
  readonly markdown?: string;
  readonly files?: Readonly<Record<string, SkillFileContent>>;
  readonly license?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CompileFromMemoryResult {
  readonly manifest: CompiledAgentManifest;
  readonly moduleMap: CompiledModuleMap;
}

/**
 * Compiles an in-process authored source through the same source composition,
 * primitive normalizers, binding validation, and kernel preparation used by a
 * filesystem-authored agent. Only module loading differs: namespaces come from
 * a scoped programmatic registry instead of JavaScript files on disk.
 */
export async function compileFromMemory(
  input: CompileFromMemoryInput,
): Promise<CompileFromMemoryResult> {
  const appRoot = input.appRoot ?? "/virtual/eve-memory-app";
  const agentRoot = input.agentRoot ?? `${appRoot}/agent`;
  const agentName = input.name ?? "memory-agent";
  const toolModules = (input.tools ?? []).map((tool) => {
    const logicalPath = `tools/${tool.name}.ts`;
    return {
      logicalPath,
      namespace: { default: createAuthoredToolDefinition(tool) },
    };
  });
  const skillModules = (input.skills ?? []).map((skill) => {
    const logicalPath = `skills/${skill.name}.ts`;
    return {
      logicalPath,
      namespace: { default: createAuthoredSkillDefinition(skill) },
    };
  });
  const applicationSource = defineProgrammaticAgentSource({
    id: MEMORY_APPLICATION_SOURCE_ID,
    modules: [
      {
        logicalPath: "agent.ts",
        namespace: { default: createAuthoredAgentDefinition(input) },
      },
      ...toolModules,
      ...skillModules,
    ],
  });
  const registry = createMemoryRegistry(applicationSource);
  const manifest = await compileAgentManifest(
    createAgentSourceManifest({
      agentId: agentName,
      agentRoot,
      appRoot,
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      skills: skillModules.map(({ logicalPath }) =>
        createModuleSourceRef({ logicalPath, sourceId: createMemorySourceId(logicalPath) }),
      ),
      tools: toolModules.map(({ logicalPath }) =>
        createModuleSourceRef({ logicalPath, sourceId: createMemorySourceId(logicalPath) }),
      ),
    }),
    {
      applicationSourceOrigin: {
        backing: { kind: "programmatic", registryId: applicationSource.id },
        layer: "application",
        owner: { kind: "application" },
      },
      modelCatalog: memoryModelCatalog,
      moduleRegistry: registry,
    },
  );

  return {
    manifest,
    moduleMap: createProgrammaticCompiledModuleMap({ manifest, registry }),
  };
}

function createMemoryRegistry(
  applicationSource: ReturnType<typeof defineProgrammaticAgentSource>,
): AgentSourceRegistry {
  return createAgentSourceRegistry([
    ...frameworkAgentSourceRegistry.registrations,
    { applyTo: "root", source: applicationSource },
  ]);
}

function createAuthoredAgentDefinition(input: CompileFromMemoryInput): Record<string, unknown> {
  const definition: Record<string, unknown> = { model: input.model };
  if (input.limits !== undefined) definition.limits = input.limits;
  if (input.outputSchema !== undefined) definition.outputSchema = input.outputSchema;
  return definition;
}

function createAuthoredToolDefinition(tool: CompileFromMemoryToolInput): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    description: tool.description ?? `${tool.name} test tool.`,
    execute: tool.execute ?? (async () => null),
  };
  if (tool.approval !== undefined) definition.approval = tool.approval;
  if (tool.execution !== undefined) definition.execution = tool.execution;
  if (tool.inputSchema !== undefined) definition.inputSchema = tool.inputSchema;
  if (tool.outputSchema !== undefined) definition.outputSchema = tool.outputSchema;
  if (tool.toModelOutput !== undefined) definition.toModelOutput = tool.toModelOutput;
  return definition;
}

function createAuthoredSkillDefinition(
  skill: CompileFromMemorySkillInput,
): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    description: skill.description,
    markdown: skill.markdown ?? `# ${skill.name}\n`,
  };
  if (skill.files !== undefined) definition.files = skill.files;
  if (skill.license !== undefined) definition.license = skill.license;
  if (skill.metadata !== undefined) definition.metadata = skill.metadata;
  return definition;
}

const memoryModelCatalog: CompiledRuntimeModelCatalogLoader = {
  async getByProviderModelId() {
    return null;
  },
  async getModelLimits() {
    return MEMORY_MODEL_LIMITS;
  },
};

function createMemorySourceId(logicalPath: string): string {
  return `memory:${logicalPath}`;
}
