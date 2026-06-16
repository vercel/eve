import { defineDynamic, defineTool } from "eve/tools";
import { defineState } from "eve/context";

const turnCount = defineState("dynamic-overwrite.turnCount", () => 0);

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        session_only: defineTool({
          description: "A tool only from session scope. Call when the user asks for session_only.",
          inputSchema: { type: "object" as const, properties: {} },
          async execute() {
            return { source: "session" };
          },
        }),
        shared: defineTool({
          description: "Shared tool, session version. Call when the user asks for shared.",
          inputSchema: { type: "object" as const, properties: {} },
          async execute() {
            return { source: "session", turn: 0 };
          },
        }),
      };
    },
    "turn.started": async () => {
      const turn = turnCount.get() + 1;
      turnCount.update(() => turn);

      return {
        shared: defineTool({
          description: "Shared tool, turn version (overrides session).",
          inputSchema: { type: "object" as const, properties: {} },
          async execute() {
            return { source: "turn", turn };
          },
        }),
      };
    },
  },
});
