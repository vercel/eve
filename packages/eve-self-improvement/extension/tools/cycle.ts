import { defineTool } from "eve/tools";
import { z } from "zod";
import { prepare, finish } from "../lib/controller.js";

/** Starts or resumes the cycle only for its real scheduled runtime principal. */
export default defineTool({
  description:
    "Start or resume the private self-improvement cycle from this extension's real app schedule. Follow its returned coordinator delegation when work is pending. Ordinary chat cannot authorize it.",
  availableInSubagents: false,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const next = await prepare(ctx);
    if (next.action === "done") return finish(next.lease, next.report, ctx.session.id);
    return {
      status: "delegated",
      agent: `${next.prefix}coordinator`,
      instruction:
        "Delegate to this coordinator to resume the stored experiment. It uses the step tool to enforce every gate. Its final result, not this start receipt, determines the outcome.",
    };
  },
});
