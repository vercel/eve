import { defineTool } from "eve/tools";
import { z } from "zod";
import { localClient } from "../../src/computer.ts";
export default defineTool({
  description:
    "Send a proactive push notification and chat message to the paired eve Start devices. Use a stable dedupeKey for the same actionable item.",
  inputSchema: z.object({
    text: z.string().min(1).max(20000),
    dedupeKey: z.string().min(1).max(200),
  }),
  execute: async ({ text, dedupeKey }) => {
    const eve = await localClient();
    const queued = await eve.notify(text, dedupeKey);
    await eve.flushNotifications();
    return { queued };
  },
});
