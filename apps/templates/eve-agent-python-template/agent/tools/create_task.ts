import { defineTool } from "eve/tools";
import { z } from "zod";
import { backendRequest } from "../lib/backend";
import { taskNotesSchema, taskSchema, taskTitleSchema } from "../lib/tasks";

export default defineTool({
  description: "Create a new task in the backend.",
  inputSchema: z.object({
    title: taskTitleSchema.describe("Short, actionable task title."),
    notes: taskNotesSchema.optional().describe("Optional details."),
  }),
  outputSchema: taskSchema,
  label: {
    start: ({ title }) => `Creating task “${title}”`,
    complete: (_input, task) => `Created task #${task.id}`,
  },
  async execute(input) {
    return taskSchema.parse(await backendRequest("/v1/tasks", { method: "POST", body: input }));
  },
});
