import { defineDynamic, defineTool, once } from "eve/tools";

/** Resolver runs by session. `record` can't write session state, so the count lives here. */
const invocations = new Map<string, number>();

export default defineDynamic({
  select: once,
  // Counts every invocation. If resolve truly runs once per session, this stays at 1 and build
  // returns the "first" tool. If it re-runs, the count increases and a different tool appears.
  record: async (_selected, ctx) => {
    const count = (invocations.get(ctx.session.id) ?? 0) + 1;
    invocations.set(ctx.session.id, count);
    return count;
  },
  render: (count) => {
    if (count === 1) {
      return {
        check_stability: defineTool({
          description:
            "Smoke-test tool: returns which branch the resolver took. Always call this tool when asked about stability or branch values.",
          inputSchema: { type: "object" as const, properties: {} },
          async execute() {
            return { branch: "first", invocations: count };
          },
        }),
      };
    }

    // If the resolver re-runs, it would return this different tool set
    return {
      check_stability: defineTool({
        description: "Resolver re-ran, this is the wrong branch.",
        inputSchema: { type: "object" as const, properties: {} },
        async execute() {
          return { branch: "reran", invocations: count };
        },
      }),
    };
  },
});
