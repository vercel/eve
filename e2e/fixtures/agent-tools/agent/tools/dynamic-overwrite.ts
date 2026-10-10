import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  select: (view) => view.session.turnCount,
  resolve: async (turn) => ({
    session_only: defineTool({
      description: "A tool only from session scope. Call when the user asks for session_only.",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        return { source: "session" };
      },
    }),
    shared: defineTool({
      description: "Shared tool, turn version. Call when the user asks for shared.",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        return { source: "turn", turn };
      },
    }),
  }),
});
