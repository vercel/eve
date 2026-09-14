import { defineTool } from "eve/tools";
import { z } from "zod";
import { readRemote } from "../lib/client";

export default defineTool({
  description: "Read the remote A2A task by its remote taskId.",
  inputSchema: z.object({ taskId: z.string() }),
  execute: ({ taskId }) => readRemote(taskId),
});
