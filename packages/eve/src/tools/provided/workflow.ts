import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  parseWorkflowProgramOptions,
} from "#execution/dynamic-workflow/schema.js";
import { executeWorkflowProgram } from "#execution/dynamic-workflow/tool.js";
import type { JsonValue } from "#shared/json.js";
import { defineWorkflowTool, type WorkflowToolDefinition } from "#tools/workflow-definition.js";
import { attachWorkflowProgramOptions } from "#tools/workflow-program-input.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface WorkflowToolOptions {
  /** Maximum child-agent calls per program, from 1 to 128. Defaults to 100. */
  readonly maxSubagents?: number;
}

export interface WorkflowToolInput {
  readonly js: string;
}

export type WorkflowTool = WorkflowToolDefinition<WorkflowToolInput, JsonValue>;

const workflowProgramAgentContract =
  "Call ctx.agent(name, { message: string, outputSchema?: object }). Each call starts a new agent that does not see this conversation, so put everything it needs in message. It resolves directly to the agent's reply; when outputSchema is provided, the reply matches that schema. It does not return an agent metadata wrapper. The owning agent resolves the target and applies its existing availability and authorization checks.";

const workflowInputSchema = defineJsonSchema<WorkflowToolInput>({
  type: "object",
  properties: {
    js: {
      type: "string",
      description: `JavaScript statements executed inside an async function. Supply only the body, without a surrounding function declaration or arrow function. ${workflowProgramAgentContract} Return one JSON-serializable value.`,
    },
  },
  required: ["js"],
  additionalProperties: false,
});

/** Defines a model-facing workflow tool backed by isolated runtime JavaScript. */
export function workflow(options: WorkflowToolOptions = {}): WorkflowTool {
  const normalized = normalizeWorkflowToolOptions(options);
  const description = [
    "Run an async JavaScript function body that invokes agents and returns one JSON-serializable value.",
    workflowProgramAgentContract,
    'Supply the body directly, for example: return await ctx.agent("researcher", { message: "Describe the task" });',
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

function normalizeWorkflowToolOptions(options: WorkflowToolOptions): {
  readonly maxSubagents: number;
} {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("workflow options must be an object.");
  }
  return parseWorkflowProgramOptions({
    maxSubagents: options.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  });
}
