import type { JsonObject } from "#shared/json.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { defineAgent } from "#public/definitions/agent.js";
import { markHarnessOwnedToolDefinition } from "#shared/harness-owned-tool.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/programmatic-module-map.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  type AgentSourceRegistry,
  type ProgrammaticAgentModule,
} from "#compiler/source-graph.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { getFrameworkAgentSourceRegistry } from "#internal/agent-sources.js";
import type { Approval } from "#public/definitions/approval.js";
import type { ToolModelOutput } from "#shared/tool-definition.js";
import type { ToolSchema } from "#shared/tool-schema.js";

/**
 * Declarative description of an in-memory authored agent used by the test
 * harness.
 */
export interface CompileFromMemoryInput {
  /** Identifies this synthetic agent in manifest metadata and error output. */
  readonly name?: string;
  /**
   * Virtual app root used in manifest paths. The directory does not need to
   * exist on disk; discovery never runs against it.
   */
  readonly appRoot?: string;
  /**
   * Virtual agent root. Defaults to `<appRoot>/agent`.
   */
  readonly agentRoot?: string;
  /** Model id assigned to the synthetic agent config. */
  readonly model: string;
  /** Session token limits assigned to the synthetic agent config. */
  readonly limits?: {
    readonly maxInputTokensPerSession?: number | false;
    readonly maxOutputTokensPerSession?: number | false;
    readonly sessionTimeoutMs?: number | false;
  };
  readonly outputSchema?: JsonObject;
  /**
   * Authored tools registered as programmatic application sources at
   * `tools/<name>.ts`. The lazy namespace loaders return the exact
   * definition values, so executors, approvals, and projections keep their
   * live closures through the ordinary compile-and-resolve pipeline.
   */
  readonly tools?: readonly CompileFromMemoryToolInput[];
  /**
   * Authored markdown skills to include in the manifest.
   */
  readonly skills?: readonly CompileFromMemorySkillInput[];
}

/**
 * Per-tool descriptor entry consumed by {@link compileFromMemory}.
 */
export interface CompileFromMemoryToolInput {
  /** Model-facing tool name; becomes the `tools/<name>.ts` slot. */
  readonly name: string;
  /** Human-readable description propagated to the compiled manifest. */
  readonly description?: string;
  /** Tool input schema (live validator or JSON schema object). */
  readonly inputSchema?: ToolSchema | JsonObject | null;
  /** Tool output schema. */
  readonly outputSchema?: ToolSchema | JsonObject;
  /** Live executor. Omit for a client-side tool. */
  readonly execute?: (input: unknown, ctx: unknown, task?: unknown) => unknown;
  readonly approval?: Approval<never>;
  readonly toModelOutput?: (output: unknown) => ToolModelOutput | Promise<ToolModelOutput>;
}

/**
 * Per-skill descriptor entry consumed by {@link compileFromMemory}.
 */
export interface CompileFromMemorySkillInput {
  readonly name: string;
  readonly description: string;
  readonly markdown?: string;
}

/**
 * Result produced by {@link compileFromMemory}. Shaped to match the subset
 * of `CompileAgentResult` that the runtime and harness need.
 */
export interface CompileFromMemoryResult {
  readonly manifest: CompiledAgentManifest;
  readonly moduleMap: CompiledModuleMap;
  /** Combined framework + in-memory registry backing the module map. */
  readonly registry: AgentSourceRegistry;
}

/** Source id under which in-memory application sources register. */
export const MEMORY_APPLICATION_SOURCE_ID = "memory";

let memoryGeneration = 0;

/**
 * Compiles an in-memory descriptor through the ordinary composer and
 * normalizers: each descriptor entry registers once as a programmatic
 * application source, the framework defaults compose beneath them, and the
 * module map resolves only the selected programmatic loaders.
 *
 * The registry revision is a fresh opaque generation per call because
 * closed-over callback state cannot be derived faithfully from function
 * source text; reusing a source id after changing callbacks can therefore
 * never hydrate stale executable code.
 */
export async function compileFromMemory(
  input: CompileFromMemoryInput,
): Promise<CompileFromMemoryResult> {
  const appRoot = input.appRoot ?? "/virtual/eve-memory-app";
  const agentRoot = input.agentRoot ?? `${appRoot}/agent`;
  const agentName = input.name ?? "memory-agent";

  const agentConfig: {
    limits?: CompileFromMemoryInput["limits"];
    model: string;
    outputSchema?: JsonObject;
  } = { model: input.model };
  if (input.limits !== undefined) {
    agentConfig.limits = input.limits;
  }
  if (input.outputSchema !== undefined) {
    agentConfig.outputSchema = input.outputSchema;
  }
  const modules: ProgrammaticAgentModule[] = [
    {
      logicalPath: "agent.ts",
      loadNamespace: async () => ({ default: defineAgent(agentConfig) }),
    },
    ...(input.tools ?? []).map((tool): ProgrammaticAgentModule => ({
      logicalPath: `tools/${tool.name}.ts`,
      loadNamespace: async () => ({ default: createMemoryToolDefinition(tool) }),
    })),
  ];

  const memorySource = defineProgrammaticAgentSource({
    id: MEMORY_APPLICATION_SOURCE_ID,
    modules,
    revision: `memory-generation-${++memoryGeneration}`,
  });
  const applicationRegistry = createAgentSourceRegistry(
    [{ applyTo: "root", source: memorySource }],
    { allowFrameworkSlots: true },
  );
  const frameworkRegistry = getFrameworkAgentSourceRegistry();
  const loaderRegistry = createAgentSourceRegistry(
    [...frameworkRegistry.registrations, ...applicationRegistry.registrations],
    { allowFrameworkSlots: true },
  );

  const manifest = await compileAgentManifest(
    createAgentSourceManifest({
      agentId: agentName,
      agentRoot,
      appRoot,
      skills: (input.skills ?? []).map((skill) => ({
        definition: {
          description: skill.description,
          markdown: skill.markdown ?? `# ${skill.name}\n`,
        },
        logicalPath: `skills/${skill.name}.md`,
        sourceId: `skills/${skill.name}.md`,
        sourceKind: "markdown" as const,
      })),
    }),
    {
      applicationRegistry,
      modelCatalog: createMemoryModelCatalogLoader(),
      registry: frameworkRegistry,
    },
  );
  const moduleMap = await createProgrammaticCompiledModuleMap({
    manifest,
    registry: loaderRegistry,
  });

  return {
    manifest,
    moduleMap,
    registry: loaderRegistry,
  };
}

function createMemoryToolDefinition(tool: CompileFromMemoryToolInput): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    description: tool.description ?? `${tool.name} test tool.`,
  };
  if (tool.inputSchema !== undefined && tool.inputSchema !== null) {
    definition.inputSchema = tool.inputSchema;
  }
  if (tool.outputSchema !== undefined) {
    definition.outputSchema = tool.outputSchema;
  }
  if (tool.approval !== undefined) {
    definition.approval = tool.approval;
  }
  if (tool.toModelOutput !== undefined) {
    definition.toModelOutput = tool.toModelOutput;
  }
  if (tool.execute === undefined) {
    return markHarnessOwnedToolDefinition(definition);
  }
  definition.execute = tool.execute;
  return definition;
}

/**
 * Hermetic model-limits loader for in-memory compilation: unit and
 * integration tests never reach the network for AI Gateway metadata.
 */
function createMemoryModelCatalogLoader(): CompiledRuntimeModelCatalogLoader {
  const limits = { contextWindowTokens: 200_000, maxOutputTokens: 64_000 };
  return {
    getByProviderModelId: async (provider, providerModelId) => ({
      limits,
      slug: `${provider}/${providerModelId}`,
    }),
    getModelLimits: async () => limits,
  };
}
