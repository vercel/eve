import { z } from "#compiled/zod/index.js";

import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  parseWorkflowProgramOptions,
} from "#execution/dynamic-workflow/schema.js";
import { executeWorkflowProgram } from "#execution/dynamic-workflow/tool.js";
import type { JsonValue } from "#shared/json.js";
import {
  defineWorkflowTool,
  type BlockingWorkflowToolDefinition,
} from "#tools/workflow-definition.js";
import { attachWorkflowProgramOptions } from "#tools/workflow-program-input.js";

export interface WorkflowToolOptions {
  /** Agent names generated JavaScript may pass to `ctx.agent`. */
  readonly agents: readonly string[];
  /** Maximum child-agent calls per program, from 1 to 128. Defaults to 100. */
  readonly maxSubagents?: number;
}

export interface WorkflowToolInput {
  readonly js: string;
}

export type WorkflowTool = BlockingWorkflowToolDefinition<WorkflowToolInput, JsonValue>;

const workflowProgramAgentContract =
  "Call ctx.agent(name, { message: string, agentId?: string, outputSchema?: object }). It resolves directly to the child's JSON-serializable output; when outputSchema is provided, the output matches that schema. It does not return an agent metadata wrapper. Use an agentId from the conversation's <agents> block to continue that child.";

const workflowInputSchema = z.strictObject({
  js: z
    .string()
    .describe(
      `JavaScript statements executed inside an async function. Supply only the body, without a surrounding function declaration or arrow function. ${workflowProgramAgentContract} Return one JSON-serializable value.`,
    ),
});

/** Defines a model-facing workflow tool backed by isolated runtime JavaScript. */
export function workflow(options: WorkflowToolOptions): WorkflowTool {
  const candidate = options as WorkflowToolOptions | null | undefined;
  const normalized = parseWorkflowProgramOptions({
    agents: candidate?.agents,
    maxSubagents: candidate?.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  });
  const description = [
    "Run an async JavaScript function body that coordinates allowlisted agents and returns one JSON-serializable value.",
    workflowProgramAgentContract,
    `Supply the body directly, for example: return await ctx.agent(${JSON.stringify(normalized.agents[0])}, { message: "Describe the task" });`,
    `Available agents: ${normalized.agents.join(", ")}.`,
    `The program may invoke at most ${String(normalized.maxSubagents)} agents.`,
  ].join(" ");
  return attachWorkflowProgramOptions(
    defineWorkflowTool({
      description,
      execute: executeWorkflowProgram,
      inputSchema: workflowInputSchema,
    }),
    normalized,
  );
}
