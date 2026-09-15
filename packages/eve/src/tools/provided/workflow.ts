import { z } from "#compiled/zod/index.js";

import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
} from "#execution/dynamic-workflow/schema.js";
import { executeWorkflowProgram } from "#execution/dynamic-workflow/tool.js";
import type { JsonValue } from "#shared/json.js";
import {
  defineWorkflowTool,
  type BlockingWorkflowToolDefinition,
} from "#tools/workflow-definition.js";
import { attachWorkflowProgramOptions } from "#tools/workflow-program-input.js";

export interface WorkflowToolOptions {
  /** Maximum child-agent calls per program, from 1 to 128. Defaults to 100. */
  readonly maxSubagents?: number;
}

export interface WorkflowToolInput {
  readonly js: string;
}

export type WorkflowTool = BlockingWorkflowToolDefinition<WorkflowToolInput, JsonValue>;

const workflowInputSchema = z.strictObject({
  js: z
    .string()
    .describe(
      "Async JavaScript function body. Use ctx.agent(name, input) and return one JSON-serializable value.",
    ),
});

/** Defines a model-facing workflow tool backed by isolated runtime JavaScript. */
export function workflow(options: WorkflowToolOptions = {}): WorkflowTool {
  const normalized = normalizeWorkflowToolOptions(options);
  const description = [
    "Run an async JavaScript function body that invokes agents through ctx.agent(name, input) and returns one JSON-serializable value.",
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
  const maxSubagents = options.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS;
  if (
    !Number.isSafeInteger(maxSubagents) ||
    maxSubagents < 1 ||
    maxSubagents > MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS
  ) {
    throw new TypeError(
      `workflow maxSubagents must be an integer between 1 and ${String(MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS)}.`,
    );
  }
  return { maxSubagents };
}
