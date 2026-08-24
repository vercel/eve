import { randomUUID } from "node:crypto";

import {
  createAgentSourceRegistry,
  composeAgentSourceRegistries,
} from "#compiler/agent-source-registry.js";
import {
  createCompileMetadata,
  resolveCompilerArtifactPaths,
  type CompileMetadata,
} from "#compiler/artifacts.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import {
  createProgrammaticCompiledModuleMap,
  createProgrammaticCompiledModuleMapIdentity,
  type CompiledModuleMap,
} from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { finalizeProgrammaticWorkspaceResources } from "#compiler/workspace-resources.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";
import { defineAgent, type AgentDefinition } from "#public/definitions/agent.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { defineSkill, type SkillDefinition } from "#public/definitions/skill.js";
import {
  defineTool,
  type BackgroundToolDefinition,
  type ToolDefinition,
} from "#public/definitions/tool.js";
import {
  createCompilerDiagnosticsArtifact,
  type CompilerDiagnosticsArtifact,
} from "#protocol/compiler-diagnostics-artifact.js";
import { identifyCompiledModuleMap } from "#protocol/compiled-module-map-identity.js";
import type { SandboxBackend } from "#shared/sandbox-backend.js";
import type { CompilerDiagnostic } from "#shared/compiler-diagnostics.js";
import type { JsonObject } from "#shared/json.js";
import type { PublicToolInputSchema, PublicToolOutputSchema } from "#shared/tool-definition.js";
import { toInputSchema, type ToolSchema } from "#shared/tool-schema.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";

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
  /** Static authored instructions compiled through `instructions.ts`. */
  readonly instructions?: string;
  readonly limits?: {
    readonly maxInputTokensPerSession?: number | false;
    readonly maxOutputTokensPerSession?: number | false;
    readonly sessionTimeoutMs?: number | false;
  };
  readonly outputSchema?: JsonObject;
  /** Optional authored `sandbox.ts` override. */
  readonly sandbox?: SandboxBackend;
  /** Enables authored background tools for task-mode integration tests. */
  readonly tasks?: boolean;
  readonly tools?: readonly CompileFromMemoryToolInput[];
  readonly skills?: readonly CompileFromMemorySkillInput[];
}

interface CompileFromMemoryToolInputBase {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: PublicToolInputSchema | null;
  readonly outputSchema?: PublicToolOutputSchema;
}

/** One ordinary `tools/<name>.ts` module in the in-memory application source. */
export type CompileFromMemoryToolInput = CompileFromMemoryToolInputBase &
  (
    | {
        readonly approval?: BackgroundToolDefinition["approval"];
        readonly execute?: BackgroundToolDefinition["execute"];
        readonly execution: "background";
        readonly toModelOutput?: BackgroundToolDefinition["toModelOutput"];
      }
    | {
        readonly approval?: ToolDefinition["approval"];
        readonly execute?: ToolDefinition["execute"];
        readonly execution?: never;
        readonly toModelOutput?: ToolDefinition["toModelOutput"];
      }
  );

/** One ordinary `skills/<name>.ts` module in the in-memory application source. */
export interface CompileFromMemorySkillInput {
  readonly name: string;
  readonly description: string;
  readonly markdown?: string;
  readonly license?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Complete compiler-owned artifact set produced by {@link compileFromMemory}. */
export interface CompileFromMemoryResult {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMap: CompiledModuleMap;
}

/**
 * Compiles an in-process authored source through the canonical source graph.
 *
 * Only the module backing differs from a filesystem build: one application
 * registry supplies lazy namespaces. Candidate construction, composition,
 * primitive normalization, binding validation, kernel preparation, module-map
 * hydration, and artifact authentication are shared with production builds.
 */
export async function compileFromMemory(
  input: CompileFromMemoryInput,
): Promise<CompileFromMemoryResult> {
  const appRoot = input.appRoot ?? "/virtual/eve-memory-app";
  const agentRoot = input.agentRoot ?? `${appRoot}/agent`;
  const agentName = input.name ?? "memory-agent";
  const applicationSource = defineProgrammaticAgentSource({
    id: MEMORY_APPLICATION_SOURCE_ID,
    revision: `compile-from-memory:${randomUUID()}`,
    modules: [
      {
        logicalPath: "agent.ts",
        loadNamespace: () => ({ default: createAuthoredAgentDefinition(input) }),
      },
      {
        logicalPath: "instructions.ts",
        loadNamespace: () => ({
          default: defineInstructions({ content: input.instructions ?? "You are a test agent." }),
        }),
      },
      ...(input.sandbox === undefined
        ? []
        : [
            {
              logicalPath: "sandbox.ts",
              loadNamespace: () => ({ default: defineSandbox({ backend: input.sandbox }) }),
            },
          ]),
      ...(input.tools ?? []).map((tool) => ({
        logicalPath: `tools/${tool.name}.ts`,
        loadNamespace: () => ({ default: createAuthoredToolDefinition(tool) }),
      })),
      ...(input.skills ?? []).map((skill) => ({
        logicalPath: `skills/${skill.name}.ts`,
        loadNamespace: () => ({ default: createAuthoredSkillDefinition(skill) }),
      })),
    ],
  });
  const applicationRegistry = createAgentSourceRegistry([
    { applyTo: "root", source: applicationSource },
  ]);
  const runtimeRegistry = composeAgentSourceRegistries([
    frameworkAgentSourceRegistry,
    applicationRegistry,
  ]);
  const discoveryManifest = createAgentSourceManifest({
    agentId: agentName,
    agentRoot,
    appRoot,
  });
  const compilerDiagnostics: CompilerDiagnostic[] = [];
  const manifest = parseCompiledAgentManifest(
    finalizeProgrammaticWorkspaceResources({
      manifest: await compileAgentManifest(discoveryManifest, {
        diagnostics: compilerDiagnostics,
        modelCatalog: memoryModelCatalog,
        registry: applicationRegistry,
      }),
    }),
  );
  const diagnostics = createCompilerDiagnosticsArtifact(compilerDiagnostics);
  const moduleMapIdentity = createProgrammaticCompiledModuleMapIdentity(manifest);
  const moduleMap = identifyCompiledModuleMap(
    await createProgrammaticCompiledModuleMap({ manifest, registry: runtimeRegistry }),
    moduleMapIdentity,
  );
  const metadata = createCompileMetadata({
    appRoot,
    compiledManifestJson: serializeArtifactJson(manifest),
    diagnosticsArtifactJson: serializeArtifactJson(diagnostics),
    diagnosticsSummary: diagnostics.summary,
    discoveryManifestJson: serializeArtifactJson(discoveryManifest),
    moduleMapIdentity,
    moduleMapSource: serializeArtifactJson({
      identity: moduleMapIdentity,
      nodes: Object.fromEntries(
        Object.entries(moduleMap.nodes).map(([nodeId, scope]) => [
          nodeId,
          { moduleIds: Object.keys(scope.modules).sort() },
        ]),
      ),
    }),
    paths: resolveCompilerArtifactPaths(appRoot),
  });

  return { diagnostics, manifest, metadata, moduleMap };
}

function createAuthoredAgentDefinition(input: CompileFromMemoryInput): AgentDefinition {
  const definition: {
    experimental?: { tasks?: boolean };
    limits?: CompileFromMemoryInput["limits"];
    model: string;
    outputSchema?: JsonObject;
  } = { model: input.model };
  if (input.tasks !== undefined) definition.experimental = { tasks: input.tasks };
  if (input.limits !== undefined) definition.limits = input.limits;
  if (input.outputSchema !== undefined) definition.outputSchema = input.outputSchema;
  return defineAgent(definition);
}

function createAuthoredToolDefinition(
  tool: CompileFromMemoryToolInput,
): ToolDefinition | BackgroundToolDefinition {
  if (tool.execution === "background") {
    const definition: {
      approval?: BackgroundToolDefinition["approval"];
      description: string;
      execute: BackgroundToolDefinition["execute"];
      execution: "background";
      inputSchema: ToolSchema;
      outputSchema?: PublicToolOutputSchema;
      toModelOutput?: BackgroundToolDefinition["toModelOutput"];
    } = {
      description: tool.description ?? `${tool.name} test tool.`,
      execute: tool.execute ?? (async () => null),
      execution: "background",
      inputSchema: toInputSchema(tool.inputSchema ?? {}),
    };
    if (tool.approval !== undefined) definition.approval = tool.approval;
    if (tool.outputSchema !== undefined) definition.outputSchema = tool.outputSchema;
    if (tool.toModelOutput !== undefined) definition.toModelOutput = tool.toModelOutput;
    return defineTool(definition);
  }

  const definition: ToolDefinition = {
    description: tool.description ?? `${tool.name} test tool.`,
    execute: tool.execute ?? (async () => null),
    inputSchema: tool.inputSchema ?? {},
  };
  if (tool.approval !== undefined) definition.approval = tool.approval;
  if (tool.outputSchema !== undefined) definition.outputSchema = tool.outputSchema;
  if (tool.toModelOutput !== undefined) definition.toModelOutput = tool.toModelOutput;
  return defineTool(definition);
}

function createAuthoredSkillDefinition(skill: CompileFromMemorySkillInput): SkillDefinition {
  const definition: {
    description: string;
    license?: string;
    markdown: string;
    metadata?: Readonly<Record<string, string>>;
  } = {
    description: skill.description,
    markdown: skill.markdown ?? `# ${skill.name}\n`,
  };
  if (skill.license !== undefined) definition.license = skill.license;
  if (skill.metadata !== undefined) definition.metadata = skill.metadata;
  return defineSkill(definition);
}

const memoryModelCatalog: CompiledRuntimeModelCatalogLoader = {
  async getByProviderModelId() {
    return null;
  },
  async getModelLimits() {
    return MEMORY_MODEL_LIMITS;
  },
};
