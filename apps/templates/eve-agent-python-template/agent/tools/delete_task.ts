import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { backendRequest } from "../lib/backend";
import { deleteTaskOutputSchema, taskIdSchema } from "../lib/tasks";

export default defineTool({
  description: "Permanently delete a task. The user is asked to approve every deletion.",
  inputSchema: z.object({ id: taskIdSchema }),
  outputSchema: deleteTaskOutputSchema,
  // Deleting is irreversible, so pause for the user's approval every time.
  approval: always(),
  label: {
    start: ({ id }) => `Delete task #${id}`,
    complete: ({ id }) => `Deleted task #${id}`,
  },
  async execute({ id }) {
    await backendRequest(`/v1/tasks/${id}`, { method: "DELETE" });
    return { deleted: true as const, id };
  },
});
