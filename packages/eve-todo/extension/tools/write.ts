import { defineTool } from "eve/tools";
import { z } from "zod";

import { todos } from "../lib/state.ts";
import { summarize, todoList } from "../lib/todos.ts";

export default defineTool({
  description:
    "Write your checklist for a task with three or more steps, replacing the whole list. Update it as you start, finish, or drop each step. Skip it for simple requests.",
  inputSchema: z.object({ todos: todoList.describe("The full, updated checklist.") }),
  execute(input) {
    todos.update(() => input.todos);
    return summarize(input.todos);
  },
});
