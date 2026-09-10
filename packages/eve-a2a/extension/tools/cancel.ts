import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelRemote } from "../lib/client";

export default defineTool({
  description: "Explicitly cancel the remote A2A task, independently of any local watcher.",
  inputSchema: z.object({ taskId: z.string() }),
  execute: ({ taskId }) => cancelRemote(taskId),
});
