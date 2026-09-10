import { scoreToolSearch, tokenizeToolSearch } from "#shared/tool-search.js";
import { asSchema, type ToolSet } from "ai";
import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { ASK_QUESTION_TOOL_NAME } from "#harness/request-input-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import { AGENT_TASK_RECEIPT_DESCRIPTION } from "#tools/framework/agent-contract.js";
import {
  serializeCodeModeWorkflowInput,
  type CodeModeToolCatalogEntry,
  type CodeModeWorkflowInput,
} from "#execution/code-mode/schema.js";
import { createWorkflowSandbox } from "#shared/workflow-sandbox.js";
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
  "Use direct tools for simple operations. Use Code Mode for substantial fan-out, loops, or filtering and combining results before returning them. " +
  "Within a program, keep related calls together. " +
  "Reuse fetched results; avoid repeated fetches and duplicate computation.";

const DISCOVERY_INSTRUCTION =
  "Use tools.search_tools and tools.describe_tools to inspect this program's tool catalog. " +
  "This catalog excludes connection tools that have not been discovered yet. " +
  "For missing connection tools, call connection_search directly outside this program, then start a new program with the discovered tools. " +
  "Tools marked requiresDirectCall must be called directly outside this program.";

/**
 * Keeps authored tools direct while loading dynamic tool schemas on demand.
 *
 * The tool catalog is pinned into `executeInput`, so
 * the durable body sees the same names and schemas after a resume. Nothing here
 * executes: the sandbox tool is built only to borrow its generated description.
 */
export async function applyCodeModeTool(input: {
  readonly continuationSecurity: WorkflowSandboxContinuationSecurity;
  readonly harnessTools: HarnessToolMap;
  readonly maxSubagents: number;
  readonly tools: ToolSet;
}): Promise<{
  readonly harnessTools: HarnessToolMap;
  readonly modelTools: ToolSet;
}> {
  const codeModeDefinition = input.harnessTools.get(CODE_MODE_TOOL_NAME);
  const codeModeModelTool = input.tools[CODE_MODE_TOOL_NAME];
  if (codeModeDefinition === undefined || codeModeModelTool === undefined) {
    return { harnessTools: input.harnessTools, modelTools: input.tools };
  }

  const { maxSubagents } = input;
  const modelTools: ToolSet = {};
  const toolCatalog: CodeModeToolCatalogEntry[] = [];
  for (const [name, tool] of Object.entries(input.tools)) {
    let description = typeof tool.description === "string" ? tool.description : "";
    let target: CodeModeToolCatalogEntry["target"] = "direct";
    let workflowId: string | undefined;
    if (claimsForCodeMode(name, input.harnessTools)) {
      const definition = input.harnessTools.get(name)!;
      if (isCodeModeAgentTool(definition)) {
        target = "agent";
      } else if (definition.workflowId !== undefined) {
        target = "workflow";
        workflowId = definition.workflowId;
      } else {
        target = "tool";
      }
    }
    if (target === "agent") {
      description = description.replace(AGENT_TASK_RECEIPT_DESCRIPTION, "").trim();
      description +=
        " Inside Code Mode, await this call for the child's final response, not a task receipt.";
    }
    if (
      name !== CODE_MODE_TOOL_NAME &&
      (target === "direct" || input.harnessTools.get(name)?.dynamic !== true)
    ) {
      modelTools[name] = tool;
    }
    const entry: { -readonly [K in keyof CodeModeToolCatalogEntry]: CodeModeToolCatalogEntry[K] } =
      {
        name,
        description,
        inputSchema: parseJsonObject(asSchema(tool.inputSchema).jsonSchema),
        outputSchema:
          target === "agent" || tool.outputSchema === undefined
            ? null
            : parseJsonObject(asSchema(tool.outputSchema).jsonSchema),
        target,
      };
    if (workflowId !== undefined) entry.workflowId = workflowId;
    toolCatalog.push(entry);
  }

  toolCatalog.sort((left, right) => (left.name < right.name ? -1 : 1));
  const discoveryTools = createDiscoveryTools(toolCatalog);
  const { description: sandboxDescription } = await createWorkflowSandbox({
    bridgeRequestLimit: codeModeBridgeRequestLimit(maxSubagents),
    continuationSecurity: input.continuationSecurity,
    hostTools: discoveryTools as ToolSet,
  });
  const generatedDescription = discoveryDescription(sandboxDescription, toolCatalog);
  const description = `${generatedDescription}\n\nA program may invoke at most ${maxSubagents} subagents in total, including retries and continuations. Excess calls reject with CODE_MODE_SUBAGENT_LIMIT_REACHED.`;
  modelTools[CODE_MODE_TOOL_NAME] = {
    ...codeModeModelTool,
    description,
    execute: undefined,
  } as ToolSet[string];

  if (codeModeDefinition.workflowId === undefined) {
    throw new Error("The framework code_mode tool is not configured as a workflow tool.");
  }
  const harnessTools = new Map(input.harnessTools);
  harnessTools.set(CODE_MODE_TOOL_NAME, {
    ...codeModeDefinition,
    description,
    executeInput: (toolInput) =>
      serializeCodeModeWorkflowInput({
        js: readProgram(toolInput),
        maxSubagents,
        toolCatalog,
      } satisfies CodeModeWorkflowInput),
  });
  return { harnessTools, modelTools };
}

/**
 * Subagents are awaited through the owner and authored workflow tools run
 * inline inside the program's run; other background tools and framework
 * controls stay direct. Approval-gated tools are claimed too: the tool step
 * evaluates their policy and the body asks the person when it requires it.
 */
export function claimsForCodeMode(name: string, tools: HarnessToolMap): boolean {
  if (name === CODE_MODE_TOOL_NAME) return false;
  // These names belong to the program's discovery helpers.
  if (name === SEARCH_TOOLS_NAME || name === DESCRIBE_TOOLS_NAME) return false;
  // The sandbox pins the exact tool names on every resume, so a tool discovered
  // mid-program could not join that program; discovery feeds the next one.
  if (name === "connection_search") return false;
  const definition = tools.get(name);
  if (definition === undefined) return false;
  if (isCodeModeAgentTool(definition)) return true;
  // The framework question tool has no executor; the body answers it through
  // the workflow-tool `ask` protocol.
  if (name === ASK_QUESTION_TOOL_NAME) {
    return definition.behavior?.handling?.kind === "request-input";
  }
  if (definition.runtimeAction !== undefined) return false;
  if (definition.behavior?.presentation === "load-skill") return false;
  if (definition.workflowId !== undefined) {
    // The catalog carries only the workflow id, so a body that depends on a
    // pinned `executeInput` cannot be started from a program.
    return definition.executeInput === undefined;
  }
  if (definition.execution === "background") return false;
  if (definition.execute === undefined) return false;
  return definition.behavior?.handling === undefined;
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
  const descriptions = catalog.map(({ name, description, inputSchema, target }) => ({
    name,
    description,
    inputSchema,
    requiresDirectCall: target === "direct",
  }));
  const toolSummarySchema = z.object({
    name: z.string(),
    description: z.string(),
    requiresDirectCall: z.boolean(),
  });
  return {
    [SEARCH_TOOLS_NAME]: {
      description:
        "Search this program's tool catalog by case-insensitive keywords in names and descriptions. " +
        "Matches any keyword; partial name matches score 3 and description matches score 1, as in connection_search. Omit query to list the catalog. " +
        "Undiscovered connection tools are excluded: call connection_search directly to find them, then start a new program.",
      inputSchema: z.object({ query: z.string().optional() }),
      outputSchema: z.array(toolSummarySchema),
      execute: async ({ query }: { readonly query?: string }) => {
        const keywords = tokenizeToolSearch(query ?? "");
        return descriptions
          .map((entry) => ({ entry, score: scoreToolSearch(keywords, entry) }))
          .filter(({ score }) => !query?.trim() || score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ entry: { description, name, requiresDirectCall } }) => ({
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
          const entry = descriptions.find((candidate) => candidate.name === name);
          return entry === undefined ? { error: "unknown tool", name } : entry;
        }),
    },
  } satisfies ToolSet;
}

function readProgram(toolInput: unknown): string {
  const js = (toolInput as { readonly js?: unknown } | undefined)?.js;
  if (typeof js !== "string") {
    throw new TypeError('code_mode requires a "js" string program.');
  }
  return js;
}

function discoveryDescription(
  generated: string,
  catalog: readonly CodeModeToolCatalogEntry[],
): string {
  const names = catalog.map((entry) => entry.name);
  return [
    generated,
    "",
    ORCHESTRATION_INSTRUCTION,
    "",
    `Available tools: ${names.join(", ")}.`,
    DISCOVERY_INSTRUCTION,
  ].join("\n");
}
