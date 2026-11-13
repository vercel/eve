import { defineTool } from "eve/tools";
import { z } from "zod";
import { backendRequest } from "../lib/backend";
import { taskIdSchema, taskNotesSchema, taskSchema, taskTitleSchema } from "../lib/tasks";

export default defineTool({
  description:
    "Update a task: rename it, change its notes, or mark it completed / not completed. Only the fields you pass change.",
  inputSchema: z
    .object({
      id: taskIdSchema,
      title: taskTitleSchema.optional(),
      notes: taskNotesSchema.nullable().optional().describe("New notes, or null to clear them."),
      completed: z.boolean().optional(),
    })
    .refine(({ title, notes, completed }) => [title, notes, completed].some((v) => v !== undefined), {
      message: "Pass at least one of title, notes, or completed.",
    }),
  outputSchema: taskSchema,
  label: {
    start: ({ id, completed }) =>
      completed === true
        ? `Completing task #${id}`
        : completed === false
          ? `Reopening task #${id}`
          : `Updating task #${id}`,
    complete: (_input, task) => `Updated “${task.title}”`,
  },
  async execute({ id, ...changes }) {
    return taskSchema.parse(
      await backendRequest(`/v1/tasks/${id}`, { method: "PATCH", body: changes }),
    );
  },
});
