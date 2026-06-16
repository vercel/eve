import { defineDynamic, defineTool } from "eve/tools";
import { defineState } from "eve/context";

const ioCallCount = defineState("dynamic-counted.ioCallCount", () => 0);

async function simulateIo(): Promise<{ label: string }> {
  ioCallCount.update((n) => n + 1);
  return { label: "fetched" };
}

export default defineDynamic({
  events: {
    "session.started": async (_event, _ctx) => {
      const data = await simulateIo();

      return {
        get_io_count: defineTool({
          description:
            "Returns how many times the resolver's I/O function has actually executed. " +
            "Only call when the user explicitly asks for the I/O count.",
          inputSchema: { type: "object" as const, properties: {} },
          async execute() {
            return { ioCallCount: ioCallCount.get(), label: data.label };
          },
        }),
      };
    },
  },
});
