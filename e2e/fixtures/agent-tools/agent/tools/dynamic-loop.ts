import { defineDynamic, defineTool } from "eve/tools";
import type { DynamicToolEntry } from "eve/tools";

const TOOL_NAMES = ["alpha", "beta"] as const;

export default defineDynamic({
  events: {
    "session.started": async () => {
      const tools: Record<string, DynamicToolEntry> = {};

      for (let i = 0; i < TOOL_NAMES.length; i++) {
        const name = TOOL_NAMES[i]!;
        const index = i;
        tools[name] = defineTool({
          description: `Loop-generated tool ${name} at index ${index}. Only call when the user asks for ${name}.`,
          inputSchema: { type: "object" as const },
          async execute() {
            return { name, index };
          },
        });
      }

      return tools;
    },
  },
});
