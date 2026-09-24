import { defineJsonSchema } from "#tools/schema.js";

export const TASK_CANCEL_TOOL_NAME = "task_cancel";

/** Framework task-control tool names lowered by the runtime. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([TASK_CANCEL_TOOL_NAME]);

export const TASK_CANCEL_INPUT_SCHEMA = defineJsonSchema<{ taskIds: string[] }>({
  type: "object",
  properties: {
    taskIds: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
      description: "Task ids from earlier subagent task receipts.",
    },
  },
  required: ["taskIds"],
  additionalProperties: false,
});

/**
 * Broad schema advertised by task-control tool outputs. Objects stay open so
 * task metadata can grow without breaking consumers of the output contract.
 */
export const TASK_VIEWS_OUTPUT_SCHEMA = defineJsonSchema({
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          inputRequests: { type: "array", items: {} },
          lastOutput: {
            type: "object",
            properties: {
              data: {},
              type: { type: "string", enum: ["result", "error"] },
            },
            required: ["data", "type"],
          },
          metadata: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              kind: { type: "string" },
              mode: { type: "string", enum: ["local", "remote"] },
              name: { type: "string" },
            },
            required: ["kind", "name"],
          },
          status: {
            type: "string",
            enum: ["working", "input_required", "completed", "failed", "cancelled"],
          },
          taskId: { type: "string" },
        },
        required: ["metadata", "status", "taskId"],
      },
    },
  },
  required: ["tasks"],
});

export interface SubagentTaskReceipt {
  agentId: string;
  status: "working";
  taskId: string;
}

export const SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA = defineJsonSchema<SubagentTaskReceipt>({
  type: "object",
  properties: {
    agentId: { type: "string" },
    status: { type: "string", const: "working" },
    taskId: { type: "string" },
  },
  required: ["agentId", "status", "taskId"],
  additionalProperties: false,
});
