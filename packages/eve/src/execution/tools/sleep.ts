import { defineJsonSchema } from "#tools/schema.js";

export { executeSleepTool } from "#execution/tools/sleep-workflow.js";

const MAX_SLEEP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

export const SLEEP_TOOL_DESCRIPTION =
  "Wait for a specified amount of time before continuing. Use this when a process or condition needs time to change before it is useful to check its progress or status again.";

export interface SleepToolInput {
  seconds: number;
}

export interface SleepToolOutput {
  waitedSeconds: number;
}

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

export const SLEEP_OUTPUT_SCHEMA = defineJsonSchema<SleepToolOutput>({
  type: "object",
  properties: {
    waitedSeconds: { type: "number", exclusiveMinimum: 0 },
  },
  required: ["waitedSeconds"],
  additionalProperties: false,
});
