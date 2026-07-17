import type { ModelMessage } from "ai";
import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

// ---------------------------------------------------------------------------
// Durable context key
// ---------------------------------------------------------------------------

/**
 * Single item in the todo list.
 */
export type TodoItem = z.infer<typeof TODO_ITEM_SCHEMA>;

/**
 * Durable state for the framework todo tool.
 */
export interface TodoState {
  readonly items: readonly TodoItem[];
}

export const TodoStateKey = new ContextKey<TodoState>("eve.todo");

/**
 * Typed input accepted by {@link executeTodoTool}.
 *
 * When `todos` is provided, the list is replaced (full replacement write).
 * When `todos` is omitted, the current list is returned without modification.
 */
export type TodoToolInput = z.infer<typeof TODO_INPUT_SCHEMA>;

function formatTodoSummary(state: TodoState): string | undefined {
  if (state.items.length === 0) return undefined;

  const lines = state.items.map((item) => {
    const check = item.status === "completed" ? "x" : item.status === "cancelled" ? "-" : " ";
    return `- [${check}] [${item.priority}] ${item.content}`;
  });

  return `[Your task list was preserved across context compaction]\n${lines.join("\n")}`;
}

/**
 * Builds the message that re-injects the current todo list after the harness
 * compacts message history, so the agent keeps its task list across
 * compaction. Returns `undefined` when there is no list to preserve.
 */
export function getTodoCompactionMessage(): ModelMessage | undefined {
  const state = loadContext().get(TodoStateKey);
  if (state === undefined || state.items.length === 0) return undefined;
  const summary = formatTodoSummary(state);
  if (summary === undefined) return undefined;
  return { content: summary, role: "user" };
}

function formatTodoResult(state: TodoState): object {
  const { items } = state;

  const counts = {
    cancelled: 0,
    completed: 0,
    in_progress: 0,
    pending: 0,
    total: items.length,
  };

  for (const item of items) {
    counts[item.status]++;
  }

  return {
    counts,
    todos: items,
  };
}

/**
 * Executes the framework todo tool.
 *
 * - Read: omit `todos` → returns the current list.
 * - Write: provide `todos` → replaces the entire list, returns the new list.
 *
 * Both paths return the same formatted output so the model always sees
 * the full current state.
 */
export function executeTodoTool(input: TodoToolInput): unknown {
  const ctx = loadContext();
  const { todos } = input ?? {};

  if (todos !== undefined) {
    const newState: TodoState = { items: [...todos] };
    ctx.set(TodoStateKey, newState);
    return formatTodoResult(newState);
  }

  const current = ctx.ensure(TodoStateKey, () => ({ items: [] }));
  return formatTodoResult(current);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const TODO_ITEM_SCHEMA = z.strictObject({
  content: z.string().describe("Brief description of the task."),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current status of the task."),
});

export const TODO_INPUT_SCHEMA = z.strictObject({
  todos: z
    .array(TODO_ITEM_SCHEMA)
    .describe("The updated todo list. Omit to read the current list without modifying it.")
    .optional(),
});

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

export const TODO_TOOL_DEFINITION: ResolvedToolDefinition = {
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
  execute: async (input) => executeTodoTool((input ?? {}) as TodoToolInput),
  inputSchema: TODO_INPUT_SCHEMA,
  logicalPath: "eve:framework/todo",
  name: "todo",
  outputSchema: TODO_OUTPUT_SCHEMA,
  sourceId: "eve:todo-tool",
  sourceKind: "module",
};
