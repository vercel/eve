import { defineWorkflowTool } from "eve/tools";
import { createWebhook } from "workflow";
import { z } from "zod";

import { postWorkflowCallback } from "../lib/webhook.ts";

export default defineWorkflowTool({
  description: "Verify a deploy callback through the public workflow webhook route.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }) {
    "use workflow";

    using callback = createWebhook({
      respondWith: new Response("callback accepted", { status: 202 }),
    });
    await callback.getConflict();
    await postWorkflowCallback(callback.url, service);
    const request = await callback;
    return { callback: await request.json() };
  },
});
