import { defineDynamic, defineTool } from "eve/tools";

/** Count memo invocations independently of the saved result. */
const invocations = new Map<string, number>();

export default defineDynamic(async (ctx) => {
  const count = await ctx.memo(ctx.session.id, () => {
    const count = (invocations.get(ctx.session.id) ?? 0) + 1;
    invocations.set(ctx.session.id, count);
    return count;
  });
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
});
