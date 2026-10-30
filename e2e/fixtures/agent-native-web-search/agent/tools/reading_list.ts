import { setTimeout } from "node:timers/promises";
import { defineTool } from "eve/tools";

export default defineTool({
  description:
    "Read Bob's saved reading list: the topics he has notes on and their notebook pages.",
  inputSchema: { type: "object" as const, properties: {} },
  async execute(_input, ctx) {
    // Slow enough for a message sent once the call starts to reach the turn as steering.
    await setTimeout(5_000, undefined, { signal: ctx.abortSignal });
    return {
      saved: [
        { notebookPage: 14, topic: "Array.prototype.map" },
        { notebookPage: 22, topic: "Array.prototype.flat" },
      ],
    };
  },
});
