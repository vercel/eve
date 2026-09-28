import { defineWorkflowTool, type WorkflowExecuteToolDefinition } from "#public/tools/index.js";
import {
  INTERRUPTED_OUTPUT_SCHEMA,
  toInterruptibleModelOutput,
  type InterruptedOutput,
} from "#tools/provided/interrupted.js";
import { executeSleepTool } from "#tools/provided/sleep-workflow.js";
import { defineJsonSchema } from "#tools/schema.js";

const MAX_SLEEP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

const SLEEP_TOOL_DESCRIPTION =
  "Wait for a specified amount of time before continuing. Use this when a process or condition needs time to change before it is useful to check its progress or status again.";

export interface SleepToolInput {
  seconds: number;
}

export type SleepToolOutput = { waitedSeconds: number } | InterruptedOutput;

export const SLEEP_INPUT_SCHEMA = defineJsonSchema<SleepToolInput>({
  type: "object",
  properties: {
    seconds: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: MAX_SLEEP_SECONDS,
      description: "How long to wait, in seconds.",
    },
  },
  required: ["seconds"],
  additionalProperties: false,
});

const SLEEP_OUTPUT_SCHEMA = defineJsonSchema<SleepToolOutput>({
  oneOf: [
    {
      type: "object",
      properties: { waitedSeconds: { type: "number", exclusiveMinimum: 0 } },
      required: ["waitedSeconds"],
      additionalProperties: false,
    },
    INTERRUPTED_OUTPUT_SCHEMA,
  ],
});

/**
 * Defines the opt-in durable `sleep` tool.
 *
 * Export it from `agent/tools/sleep.ts`:
 *
 * ```ts
 * import { sleep } from "eve/tools/sleep";
 *
 * export default sleep();
 * ```
 *
 * Each call runs as a durable workflow, so the wait does not hold an
 * application runtime open. A new message ends the wait early.
 */
export function sleep(): WorkflowExecuteToolDefinition<SleepToolInput, SleepToolOutput> {
  return defineWorkflowTool({
    description: SLEEP_TOOL_DESCRIPTION,
    execute: executeSleepTool,
    inputSchema: SLEEP_INPUT_SCHEMA,
    outputSchema: SLEEP_OUTPUT_SCHEMA,
    toModelOutput: toInterruptibleModelOutput,
  });
}
