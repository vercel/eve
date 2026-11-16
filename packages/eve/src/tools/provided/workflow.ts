import { PROGRAM_MAX_AGENT_CALLS } from "#execution/code-mode/limits.js";
import { PROGRAM_CODE_INPUT_DESCRIPTION } from "#execution/code-mode/sandbox.js";
import {
  parseWorkflowProgramOptions,
  runWorkflowProgramTask,
} from "#execution/code-mode/workflow-program.js";
import type { JsonValue } from "#shared/json.js";
import { defineWorkflowTool, type WorkflowTaskToolDefinition } from "#tools/workflow-definition.js";
import { attachWorkflowProgramOptions } from "#tools/workflow-program-input.js";
import { defineJsonSchema } from "#tools/schema.js";

import { frameworkTool } from "./framework-tool.js";

export interface WorkflowToolOptions {
  /** Maximum agent calls per program, from 1 to 128. Defaults to 128. */
  readonly maxSubagents?: number;
}

export interface WorkflowToolInput {
  /** The body of an async function, in the language `eve__execute` runs. */
  readonly code: string;
}

export type WorkflowTool = WorkflowTaskToolDefinition<WorkflowToolInput, JsonValue>;

const workflowInputSchema = defineJsonSchema<WorkflowToolInput>({
  type: "object",
  properties: {
    code: { type: "string", description: PROGRAM_CODE_INPUT_DESCRIPTION },
  },
  required: ["code"],
  additionalProperties: false,
});

/**
 * Defines a tool that runs a program the model writes in the background, as a task. The program
 * is written like one for code mode's `eve__execute`, and its `tools` holds agents only.
 */
export function workflow(options: WorkflowToolOptions = {}): WorkflowTool {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("workflow options must be an object.");
  }
  const normalized = parseWorkflowProgramOptions({
    maxSubagents: options.maxSubagents ?? PROGRAM_MAX_AGENT_CALLS,
  });
  const description = [
    "Run a JavaScript program in the background that calls agents and returns one JSON value.",
    "It runs as a task: you get a receipt now and the result later, so you can keep working while it runs, and a new message doesn't stop it.",
    "Use it for agent work you don't need the result of in this step.",
    'Call an agent as `await tools.<name>({ message, outputSchema? })`, using its exact name (`tools["name"]` when the name isn\'t an identifier).',
    "Each call starts a new agent session that does not see this conversation, so put everything the agent needs in `message`.",
    "A call resolves to the agent's reply, or to a value matching `outputSchema` when you pass one; a failed call throws.",
    "Start calls that don't depend on each other together with `Promise.all`, and await every call before returning.",
    "`tools` holds agents only: there are no other tools, and no search, fetch, file system, timers, or imports.",
    "`console.log` output is returned with the result.",
    `A program may call agents at most ${String(normalized.maxSubagents)} times.`,
  ].join(" ");
  return attachWorkflowProgramOptions(
    frameworkTool(
      defineWorkflowTool({
        description,
        inputSchema: workflowInputSchema,
        task: runWorkflowProgramTask,
      }),
    ),
    normalized,
  );
}
