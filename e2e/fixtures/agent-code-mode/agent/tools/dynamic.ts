import { defineDynamic, defineTool } from "eve/tools";
import { never } from "eve/tools/approval";

export default defineDynamic({
  events: {
    "session.started": () => ({
      shared: defineTool({
        description: "Session shared definition.",
        inputSchema: { type: "object" },
        execute: () => "session",
      }),
    }),
    "turn.started": () => ({
      shared: defineTool({
        description: "Turn shared definition.",
        inputSchema: { type: "object" },
        execute: () => "turn",
      }),
    }),
    "step.started": () => ({
      shared: defineTool({
        description: "Step shared definition.",
        inputSchema: { type: "object" },
        execute: () => "step",
      }),
      discovered: defineTool({
        description: "A dynamic tool with no static definition.",
        inputSchema: { type: "object" },
        approval: never(),
        execute: () => "discovered",
      }),
    }),
  },
});
