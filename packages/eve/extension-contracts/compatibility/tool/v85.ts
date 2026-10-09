import { z } from "zod";
import { defineTool } from "#public/tools/index.js";
import { always } from "#public/tools/approval/index.js";

// Epoch 85 tool contexts had no `approval`; epoch 86 adds it as optional, set
// only when a call runs after a person approved it. Approved tools that read
// only `ctx.session.auth` keep running as the requester.
export default defineTool({
  description: "Report who requested the release check.",
  inputSchema: z.object({ release: z.string() }),
  approval: { request: always() },
  execute: ({ release }, ctx) => ({
    release,
    requester: ctx.session.auth.current?.principalId ?? null,
  }),
});
