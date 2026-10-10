import { defineDynamic, defineTool } from "eve/tools";

const TOKEN = "dynamic-turn-replay-ok-V6N";

export default defineDynamic({
  select: (view) => view.latest["turn.started"] ?? null,
  resolve: (_event, ctx) => {
    const resolvedSessionId = ctx.session.id;
    return {
      dynamic_turn_replay_probe: defineTool({
        description:
          "Verify a turn-scoped dynamic callback after a durable workflow resumes. Only call for DYNAMIC-TURN-REPLAY-START.",
        inputSchema: { type: "object" },
        execute() {
          return { resolvedSessionId, token: TOKEN };
        },
      }),
    };
  },
});
