import { asSchema, type ToolSet } from "ai";
import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { isNeverApproval } from "#tools/approval/policies.js";
import {
  DEFAULT_CODE_MODE_MAX_SUBAGENTS,
  serializeCodeModeWorkflowInput,
  type CodeModeMode,
  type CodeModeToolCatalogEntry,
  type CodeModeWorkflowInput,
} from "#execution/code-mode/schema.js";
import { createWorkflowSandboxTool } from "#shared/workflow-sandbox.js";
import type { WorkflowSandboxContinuationSecurity } from "#shared/workflow-sandbox.js";
import { parseJsonObject } from "#shared/json.js";

export const CODE_MODE_TOOL_NAME = "code_mode";
export const SEARCH_TOOLS_NAME = "search_tools";
export const DESCRIBE_TOOLS_NAME = "describe_tools";
export function codeModeBridgeRequestLimit(maxSubagents: number): number {
  // Leave room for the first excess call to receive the framework budget error.
  return Math.max(256, maxSubagents + 1);
}

const ORCHESTRATION_INSTRUCTION =
  "Keep related tool calls and data processing together in one program and return what the user needs. " +
  "Reuse fetched results; avoid repeated fetches and duplicate computation.";

const EAGER_SELECTION_INSTRUCTION =
  "Prefer code_mode for dependent lookups, pagination, loops, or filtering and aggregating tool results. " +
  "Prefer direct tools when a single call or native batch already produces the needed result with little further processing. " +
  "Use the supplied tool schemas without unnecessary discovery.";

const DISCOVERY_INSTRUCTION =
  "Use tools.search_tools and tools.describe_tools to discover every available tool. " +
  "Tools marked requiresDirectCall must be called directly outside this program.";

export type { CodeModeMode };

/**
 * Exposes eligible tools through `code_mode`, retaining direct calls in eager mode.
 *
 * The discovery catalog and callable names are pinned into `executeInput`, so
 * the durable body sees the same names and schemas after a resume. Nothing here
 * executes: the sandbox tool is built only to borrow its generated description.
 */
export async function applyCodeModeTool(input: {
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly harnessTools: HarnessToolMap;
  readonly mode: CodeModeMode;
  readonly maxSubagents?: number;
  readonly tools: ToolSet;
}): Promise<{
  readonly claimedToolNames: readonly string[];
  readonly harnessTools: HarnessToolMap;
  readonly modelTools: ToolSet;
}> {
  const codeModeDefinition = input.harnessTools.get(CODE_MODE_TOOL_NAME);
  const codeModeModelTool = input.tools[CODE_MODE_TOOL_NAME];
  if (codeModeDefinition === undefined || codeModeModelTool === undefined) {
    return { claimedToolNames: [], harnessTools: input.harnessTools, modelTools: input.tools };
  }

  const maxSubagents = input.maxSubagents ?? DEFAULT_CODE_MODE_MAX_SUBAGENTS;
  const hostTools: Record<string, ToolSet[string]> = {};
  const modelTools: Record<string, ToolSet[string]> = {};
  for (const [name, tool] of Object.entries(input.tools)) {
    if (claimsForCodeMode(name, input.harnessTools)) {
      hostTools[name] = tool;
      if (input.mode === "eager") modelTools[name] = tool;
    } else if (name !== CODE_MODE_TOOL_NAME) {
      modelTools[name] = tool;
    }
  }
  const claimedToolNames = Object.keys(hostTools).sort();
  const toolCatalog: CodeModeToolCatalogEntry[] = Object.keys(input.tools)
    .sort()
    .map((name) => {
      const tool = input.tools[name]!;
      return {
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: parseJsonObject(asSchema(tool.inputSchema).jsonSchema),
        requiresDirectCall: !Object.hasOwn(hostTools, name),
      };
    });

  const discoveryTools = createDiscoveryTools(toolCatalog);
  Object.assign(hostTools, discoveryTools);
  const generated = await createWorkflowSandboxTool({
    bridgeRequestLimit: codeModeBridgeRequestLimit(maxSubagents),
    continuationSecurity: input.continuationSecurity,
    hostTools: (input.mode === "lazy" ? discoveryTools : hostTools) as ToolSet,
  });
  const generatedDescription =
    input.mode === "lazy"
      ? lazyDescription(generated, toolCatalog)
      : `${EAGER_SELECTION_INSTRUCTION}\n\n${ORCHESTRATION_INSTRUCTION}\n\nTools marked requiresDirectCall must be called directly outside this program.\n\n${generated.description ?? ""}`;
  const description = `${generatedDescription}\n\nA program may invoke at most ${maxSubagents} subagents in total, including retries and continuations. Excess calls reject with CODE_MODE_SUBAGENT_LIMIT_REACHED.`;
  modelTools[CODE_MODE_TOOL_NAME] = {
    ...codeModeModelTool,
    description,
    execute: undefined,
  } as ToolSet[string];

  if (codeModeDefinition.workflowId === undefined) {
    throw new Error("The framework code_mode tool is not configured as a workflow tool.");
  }
  const mode = input.mode;
  const harnessTools = new Map(input.harnessTools);
  harnessTools.set(CODE_MODE_TOOL_NAME, {
    ...codeModeDefinition,
    description,
    executeInput: (toolInput) =>
      serializeCodeModeWorkflowInput({
        js: readProgram(toolInput),
        mode,
        maxSubagents,
        toolNames: claimedToolNames,
        toolCatalog,
      } satisfies CodeModeWorkflowInput),
  });
  return { claimedToolNames, harnessTools, modelTools: modelTools as ToolSet };
}

/**
 * Subagents are awaited through the owner; other background tools, approval
 * gates, framework controls, and authored workflow tools stay direct.
 */
export function claimsForCodeMode(name: string, tools: HarnessToolMap): boolean {
  if (name === CODE_MODE_TOOL_NAME) return false;
  // These names belong to the program's discovery helpers.
  if (name === SEARCH_TOOLS_NAME || name === DESCRIBE_TOOLS_NAME) return false;
  // Discovery updates the parent context for the next model step's catalog.
  if (name === "connection_search") return false;
  const definition = tools.get(name);
  if (definition === undefined) return false;
  if (isCodeModeAgentTool(definition)) return true;
  if (definition.execution === "background") return false;
  if (definition.execute === undefined) return false;
  if (definition.behavior?.presentation === "load-skill") return false;
  if (definition.workflowId !== undefined || definition.runtimeAction !== undefined) return false;
  if (definition.behavior?.handling !== undefined) return false;
  return definition.approval === undefined || isNeverApproval(definition.approval);
}

/**
 * Any subagent tool. Declared subagents are background tools on the direct
 * surface (they return a receipt); inside a program the body invokes them
 * through the owner's `agent-invoke` channel and waits for the result, so
 * generated code can `await` them like any other call.
 */
export function isCodeModeAgentTool(definition: HarnessToolDefinition): boolean {
  return definition.resultKind === "subagent";
}

/** Discovery covers the complete advertised catalog, independently of execution routing. */
export function createDiscoveryTools(catalog: readonly CodeModeToolCatalogEntry[]) {
  const toolSummarySchema = z.object({
    name: z.string(),
    description: z.string(),
    requiresDirectCall: z.boolean(),
  });
  return {
    [SEARCH_TOOLS_NAME]: {
      description:
        "Search all available tools by case-insensitive substring of their name or description. " +
        "Use a short term, or omit query to list all tools.",
      inputSchema: z.object({ query: z.string().optional() }),
      outputSchema: z.array(toolSummarySchema),
      execute: async ({ query }: { readonly query?: string }) => {
        const needle = query?.toLowerCase().trim() ?? "";
        return catalog
          .filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(needle))
          .map(({ description, name, requiresDirectCall }) => ({
            description,
            name,
            requiresDirectCall,
          }));
      },
    },
    [DESCRIBE_TOOLS_NAME]: {
      description:
        "Describe every tool needed for the task, including final writes, before executing it.",
      inputSchema: z.object({ names: z.array(z.string()) }),
      outputSchema: z.array(
        z.union([
          toolSummarySchema.extend({ inputSchema: z.record(z.string(), z.unknown()) }),
          z.object({ name: z.string(), error: z.literal("unknown tool") }),
        ]),
      ),
      execute: async ({ names }: { readonly names: readonly string[] }) =>
        names.map((name) => {
          const entry = catalog.find((candidate) => candidate.name === name);
          return entry === undefined ? { error: "unknown tool", name } : entry;
        }),
    },
  } satisfies ToolSet;
}

/** Descriptor-only stand-in for a claimed tool; the body executes it in its own step. */
export function describeClaimedTool(definition: HarnessToolDefinition): ToolSet[string] {
  return {
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  } as ToolSet[string];
}

function readProgram(toolInput: unknown): string {
  const js = (toolInput as { readonly js?: unknown } | undefined)?.js;
  if (typeof js !== "string") {
    throw new TypeError('code_mode requires a "js" string program.');
  }
  return js;
}

function lazyDescription(
  tool: ToolSet[string],
  catalog: readonly CodeModeToolCatalogEntry[],
): string {
  const generated = typeof tool.description === "string" ? tool.description : "";
  const names = catalog.map((entry) => entry.name);
  return [
    generated,
    "",
    ORCHESTRATION_INSTRUCTION,
    "",
    `Available tools: ${names.sort().join(", ")}.`,
    DISCOVERY_INSTRUCTION,
  ].join("\n");
}
