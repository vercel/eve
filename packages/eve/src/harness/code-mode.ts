import { asSchema, type ToolSet } from "ai";
import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { isNeverApproval } from "#tools/approval/policies.js";
import {
  serializeCodeModeWorkflowInput,
  type CodeModeMode,
  type CodeModeWorkflowInput,
} from "#execution/code-mode/schema.js";
import { createWorkflowSandboxTool } from "#shared/workflow-sandbox.js";
import type { WorkflowSandboxContinuationSecurity } from "#shared/workflow-sandbox.js";

export const CODE_MODE_TOOL_NAME = "code_mode";
export const SEARCH_TOOLS_NAME = "search_tools";
export const DESCRIBE_TOOLS_NAME = "describe_tools";
export const CODE_MODE_BRIDGE_REQUEST_LIMIT = 256;

const ORCHESTRATION_INSTRUCTION =
  "Call code_mode at most once per response. Put dependent calls, loops, retries, and parallel work in one program.";

export type { CodeModeMode };

/**
 * Moves eligible tools behind the framework `code_mode` workflow tool.
 *
 * The claimed catalog is pinned into the tool's `executeInput`, so the durable
 * body replays against exactly the names the model was shown. Nothing here
 * executes: the sandbox tool is built only to borrow its generated description.
 */
export async function applyCodeModeTool(input: {
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly harnessTools: HarnessToolMap;
  readonly mode: CodeModeMode;
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

  const hostTools: Record<string, ToolSet[string]> = {};
  const modelTools: Record<string, ToolSet[string]> = {};
  for (const [name, tool] of Object.entries(input.tools)) {
    if (claimsForCodeMode(name, input.harnessTools)) {
      hostTools[name] = tool;
    } else if (name !== CODE_MODE_TOOL_NAME) {
      modelTools[name] = tool;
    }
  }
  const claimedToolNames = Object.keys(hostTools).sort();
  if (claimedToolNames.length === 0) {
    const harnessTools = new Map(input.harnessTools);
    harnessTools.delete(CODE_MODE_TOOL_NAME);
    return { claimedToolNames, harnessTools, modelTools: modelTools as ToolSet };
  }

  if (input.mode === "lazy") Object.assign(hostTools, createDiscoveryTools(hostTools));
  const generated = await createWorkflowSandboxTool({
    bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
    continuationSecurity: input.continuationSecurity,
    hostTools: hostTools as ToolSet,
  });
  const description =
    input.mode === "lazy"
      ? lazyDescription(generated, hostTools as ToolSet)
      : `${ORCHESTRATION_INSTRUCTION}\n\n${generated.description ?? ""}`;
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
        toolNames: claimedToolNames,
      } satisfies CodeModeWorkflowInput),
  });
  return { claimedToolNames, harnessTools, modelTools: modelTools as ToolSet };
}

/**
 * A tool enters the program catalog when the durable body can settle it
 * without parking on a human: ordinary executable tools with no approval
 * gate, and subagents, which the body reaches through the owner's
 * `agent-invoke` channel. Framework controls and authored workflow tools
 * stay direct.
 */
export function claimsForCodeMode(name: string, tools: HarnessToolMap): boolean {
  if (name === CODE_MODE_TOOL_NAME) return false;
  const definition = tools.get(name);
  if (definition === undefined) return false;
  if (isCodeModeAgentTool(definition)) return true;
  if (definition.execute === undefined) return false;
  if (definition.behavior?.presentation === "load-skill") return false;
  if (definition.workflowId !== undefined || definition.runtimeAction !== undefined) return false;
  if (definition.behavior?.handling !== undefined) return false;
  return definition.approval === undefined || isNeverApproval(definition.approval);
}

/** A blocking subagent tool; background variants return receipts and stay direct. */
export function isCodeModeAgentTool(definition: HarnessToolDefinition): boolean {
  return definition.resultKind === "subagent" && definition.execution !== "background";
}

/** Discovery helpers exposed to generated code in `"lazy"` mode. */
export function createDiscoveryTools(
  catalog: Record<string, ToolSet[string]>,
): Record<string, ToolSet[string]> {
  const entries = Object.entries(catalog).map(([name, tool]) => ({
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.inputSchema,
    name,
  }));
  return {
    [SEARCH_TOOLS_NAME]: {
      description: "Search the code-mode tool catalog.",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: async ({ query }: { readonly query?: string }) => {
        const needle = query?.toLowerCase().trim() ?? "";
        return entries
          .filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(needle))
          .map(({ description, name }) => ({ description, name }));
      },
    } as ToolSet[string],
    [DESCRIBE_TOOLS_NAME]: {
      description: "Return descriptions and input schemas for code-mode tools.",
      inputSchema: z.object({ names: z.array(z.string()) }),
      execute: async ({ names }: { readonly names: readonly string[] }) =>
        names.map((name) => {
          const entry = entries.find((candidate) => candidate.name === name);
          return entry === undefined
            ? { error: "unknown tool", name }
            : {
                description: entry.description,
                inputSchema: asSchema(entry.inputSchema).jsonSchema,
                name,
              };
        }),
    } as ToolSet[string],
  };
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

function lazyDescription(tool: ToolSet[string], hostTools: ToolSet): string {
  const generated = typeof tool.description === "string" ? tool.description : "";
  const header = generated.split("Tools:\n", 1)[0]?.trimEnd() ?? generated;
  const names = Object.keys(hostTools).filter(
    (name) => name !== SEARCH_TOOLS_NAME && name !== DESCRIBE_TOOLS_NAME,
  );
  return [
    header,
    "",
    ORCHESTRATION_INSTRUCTION,
    "",
    `Available tools: ${names.sort().join(", ")}.`,
    `Use tools.${SEARCH_TOOLS_NAME} and tools.${DESCRIBE_TOOLS_NAME} to discover signatures.`,
  ].join("\n");
}
