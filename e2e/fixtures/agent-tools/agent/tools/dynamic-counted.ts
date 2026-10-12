import { defineDynamic, defineTool, once } from "eve/tools";

/** I/O runs by session. `record` can't write session state, so the count lives in the process. */
const ioCallCount = new Map<string, number>();

async function simulateIo(sessionId: string): Promise<{ label: string }> {
  ioCallCount.set(sessionId, (ioCallCount.get(sessionId) ?? 0) + 1);
  return { label: "fetched" };
}

export default defineDynamic({
  select: once,
  record: (_selected, ctx) => simulateIo(ctx.session.id),
  render: (data) => {
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
  },
});
