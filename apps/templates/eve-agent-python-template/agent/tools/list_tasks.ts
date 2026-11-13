import { defineTool } from "eve/tools";
import { z } from "zod";
import { backendRequest } from "../lib/backend";
import { listTasksOutputSchema, taskSchema } from "../lib/tasks";

const STATUS_FILTER = { open: false, completed: true, all: undefined } as const;

export default defineTool({
  description:
    "List the user's tasks from the backend, open tasks first. Use this before updating or deleting a task to find its id.",
  inputSchema: z.object({
    status: z
      .enum(["open", "completed", "all"])
      .optional()
      .describe('Which tasks to return. Defaults to "all".'),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum tasks (default 50)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Tasks to skip, for paging. If a full page comes back, list again with offset += limit."),
  }),
  outputSchema: listTasksOutputSchema,
  label: {
    start: ({ status = "all" }) => `Listing ${status === "all" ? "" : `${status} `}tasks`,
    complete: (_input, { tasks }) => `Found ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
  },
  async execute({ status = "all", limit, offset }) {
    const tasks = await backendRequest<unknown>("/v1/tasks", {
      query: { completed: STATUS_FILTER[status], limit, offset },
    });
    return { tasks: z.array(taskSchema).parse(tasks) };
  },
});
