import { defineTool } from "eve/tools";
import { z } from "zod";
import { sendRemote } from "../lib/client";

export default defineTool({
  description:
    "Send a message to the configured A2A agent. Pass its remote taskId to answer an interrupted task.",
  inputSchema: z.object({ message: z.string(), taskId: z.string().optional() }),
  execute: ({ message, taskId }) => sendRemote(message, taskId),
});
