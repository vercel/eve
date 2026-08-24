import { z } from "#compiled/zod/index.js";

import { executeTodoTool } from "#execution/tools/todo.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

export const TODO_ITEM_SCHEMA = z.strictObject({
  content: z.string().describe("Brief description of the task."),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current status of the task."),
});

/** One item in the durable todo list. */
export type TodoItem = z.infer<typeof TODO_ITEM_SCHEMA>;

export const TODO_INPUT_SCHEMA = z.strictObject({
  todos: z
    .array(TODO_ITEM_SCHEMA)
    .describe("The updated todo list. Omit to read the current list without modifying it.")
    .optional(),
});

/**
 * Input accepted by the todo primitive. Providing `todos` replaces the list;
 * omitting it reads the current list.
 */
export type TodoToolInput = z.infer<typeof TODO_INPUT_SCHEMA>;

const countSchema = z.number().int().min(0);
export const TODO_OUTPUT_SCHEMA = z.strictObject({
  counts: z.strictObject({
    cancelled: countSchema,
    completed: countSchema,
    in_progress: countSchema,
    pending: countSchema,
    total: countSchema,
  }),
  todos: z.array(TODO_ITEM_SCHEMA),
});

/** eve's canonical durable todo definition. */
export const todo: ToolDefinition = {
  description: [
    "Use this tool to create and manage a structured task list for the current session.",
    "This helps you track progress, organize complex tasks, and demonstrate thoroughness.",
    "",
    "When to use:",
    "- Complex multistep tasks requiring 3 or more distinct steps",
    "- When the user provides multiple tasks or a numbered list",
    "- After receiving new instructions, to capture requirements",
    "- After completing a task, to mark it complete and add follow-ups",
    "",
    "When NOT to use:",
    "- Single, straightforward tasks that need no tracking",
    "- Purely conversational or informational requests",
    "",
    "Usage:",
    "- Call with `todos` to replace the entire list (full replacement write)",
    "- Call without `todos` to read the current list",
    "- Both return the full current list with status counts",
    "- Mark tasks in_progress when you start, completed when done",
    "- Only have ONE task in_progress at a time",
  ].join("\n"),
  async execute(input) {
    return executeTodoTool((input ?? {}) as TodoToolInput);
  },
  inputSchema: TODO_INPUT_SCHEMA,
  outputSchema: TODO_OUTPUT_SCHEMA,
};
