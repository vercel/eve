import {
  executeTodoTool,
  TODO_INPUT_SCHEMA,
  TODO_OUTPUT_SCHEMA,
  type TodoToolInput,
} from "#execution/tools/todo.js";
import { defineTool } from "#tools/definition.js";

export const todo = defineTool({
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
  activity: {
    label: (input) => (input.todos === undefined ? "Read todo list" : "Update todo list"),
    state: { key: "todo", project: (output) => output.todos },
  },
  execute: async (input) => executeTodoTool((input ?? {}) as TodoToolInput),
  inputSchema: TODO_INPUT_SCHEMA,
  outputSchema: TODO_OUTPUT_SCHEMA,
});

export default todo;
