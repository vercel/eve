import type { JsonObject } from "#shared/json.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import {
  type CompiledAgentDefinition,
  type CompiledAgentManifest,
  type CompiledSkillDefinition,
  type CompiledToolDefinition,
  createCompiledAgentManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";

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
  readonly outputSchema?: JsonObject;
  /**
   * Authored tools to project into the compiled manifest and module map.
   *
   * Each entry corresponds to a single module-backed tool. The harness does
   * not load the tool module from disk — its runtime behaviour is injected
   * separately via the AppHarness `mockTool` API.
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
  /** Model-facing tool name; must match the slot name in the module map. */
  readonly name: string;
  /** Human-readable description propagated to the compiled manifest. */
  readonly description?: string;
  /**
   * JSON-schema-like object describing the tool input. Passed through as-is
   * (lowered to `null` when omitted).
   */
  readonly inputSchema?: JsonObject | null;
  /** JSON-schema-like object describing the tool output. */
  readonly outputSchema?: JsonObject;
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
}

/**
 * Builds a compiled manifest and matching module map directly from an
 * in-memory descriptor, bypassing discovery and bundling entirely.
 *
 * Intended for integration tests that want to exercise runtime behaviour
 * without the cost of real compilation. Production code must continue to
 * use {@link compileAgent}.
 */
export function compileFromMemory(input: CompileFromMemoryInput): CompileFromMemoryResult {
  const appRoot = input.appRoot ?? "/virtual/eve-memory-app";
  const agentRoot = input.agentRoot ?? `${appRoot}/agent`;
  const agentName = input.name ?? "memory-agent";

  const config: CompiledAgentDefinition = {
    model: { id: input.model, routing: classifyModelRouting(input.model) },
    name: agentName,
  };
  if (input.outputSchema !== undefined) {
    config.outputSchema = input.outputSchema;
  }

  const tools: CompiledToolDefinition[] = (input.tools ?? []).map((toolInput) => ({
    description: toolInput.description ?? `${toolInput.name} test tool.`,
    inputSchema: toolInput.inputSchema ?? null,
    logicalPath: `tools/${toolInput.name}.ts`,
    name: toolInput.name,
    outputSchema: toolInput.outputSchema,
    sourceId: createMemorySourceId(`tools/${toolInput.name}.ts`),
    sourceKind: "module",
  }));

  const skills: CompiledSkillDefinition[] = (input.skills ?? []).map((skillInput) => ({
    description: skillInput.description,
    logicalPath: `skills/${skillInput.name}.md`,
    markdown: skillInput.markdown ?? `# ${skillInput.name}\n`,
    name: skillInput.name,
    sourceId: createMemorySourceId(`skills/${skillInput.name}.md`),
    sourceKind: "markdown",
  }));

  const manifest = createCompiledAgentManifest({
    agentRoot,
    appRoot,
    config,
    skills,
    tools,
  });

  const moduleMap: CompiledModuleMap = {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: Object.fromEntries(
          tools.map((tool) => [tool.sourceId, Object.freeze({}) as Record<string, unknown>]),
        ),
      },
    },
  };

  return {
    manifest,
    moduleMap,
  };
}

function createMemorySourceId(logicalPath: string): string {
  // A deterministic, stable id per logical path. The runtime only requires
  // these to be unique within the module map, so a prefix + the path is
  // sufficient — no hashing needed.
  return `memory::${logicalPath}`;
}
