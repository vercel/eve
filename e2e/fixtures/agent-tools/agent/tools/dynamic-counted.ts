import { defineDynamic, defineTool } from "eve/tools";

/** Count memo I/O independently of the session's saved memo result. */
const ioCallCount = new Map<string, number>();

async function simulateIo(sessionId: string): Promise<{ label: string }> {
  ioCallCount.set(sessionId, (ioCallCount.get(sessionId) ?? 0) + 1);
  return { label: "fetched" };
}

export default defineDynamic(async (ctx) => {
  const data = await ctx.memo(ctx.session.id, () => simulateIo(ctx.session.id));
  return {
    get_io_count: defineTool({
      description:
        "Returns how many times the resolver's I/O function has actually executed. " +
        "Only call when the user explicitly asks for the I/O count.",
      inputSchema: { type: "object" as const, properties: {} },
      async execute(_input, toolCtx) {
        return { ioCallCount: ioCallCount.get(toolCtx.session.id) ?? 0, label: data.label };
      },
    }),
  };
});
