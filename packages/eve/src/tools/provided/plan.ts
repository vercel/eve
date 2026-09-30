import { defineTool, type ToolDefinition } from "#public/tools/index.js";
import { defineJsonSchema } from "#tools/schema.js";

/** The tool's path-derived name, which channels recognize its calls by. */
export const PLAN_TOOL_NAME = "plan";

export const PLAN_ITEM_STATUSES = ["pending", "working", "completed", "failed"] as const;
export const MAX_PLAN_ITEMS = 12;
export const MAX_PLAN_ITEM_TITLE_LENGTH = 120;

/** One step of the checklist a channel shows for the current turn. */
export interface PlanItem {
  readonly status: (typeof PLAN_ITEM_STATUSES)[number];
  readonly title: string;
}

export interface PlanToolInput {
  readonly items: readonly PlanItem[];
}

export interface PlanToolOutput {
  readonly updated: true;
}

export const PLAN_INPUT_SCHEMA = defineJsonSchema<PlanToolInput>({
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
      description: "The complete checklist, in order. Items left out are removed.",
      items: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...PLAN_ITEM_STATUSES] },
          title: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PLAN_ITEM_TITLE_LENGTH,
            description: "A short phrase a person can scan, such as 'Check recent deploys'.",
          },
        },
        required: ["status", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
});

export const PLAN_OUTPUT_SCHEMA = defineJsonSchema<PlanToolOutput>({
  type: "object",
  properties: { updated: { type: "boolean", const: true } },
  required: ["updated"],
  additionalProperties: false,
});

/**
 * Shows the steps of a multi-step request as a checklist, such as the rows of a
 * Slack task card. The call only records the list; channels render it.
 */
export const plan: ToolDefinition<PlanToolInput, PlanToolOutput> = defineTool({
  label: { start: () => "Update plan" },
  description: [
    "Show a short checklist of the steps for a multi-step request. People see it as a live progress card.",
    "Pass the complete list on every call, and update each item's status as you work.",
    "Tasks you start appear on the card on their own, so don't add an item only to show one.",
    "Before your final reply, mark every item completed or failed.",
    "Don't use this for a request you can answer in one step.",
  ].join("\n"),
  execute() {
    return { updated: true as const };
  },
  inputSchema: PLAN_INPUT_SCHEMA,
  outputSchema: PLAN_OUTPUT_SCHEMA,
});

export default plan;
