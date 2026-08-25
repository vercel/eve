import { defineTool } from "eve/tools";
import { z } from "zod";

declare global {
  var __eveInstrumentationSnapshot: unknown;
  var __eveLiveChannelMetadata: unknown;
}

export default defineTool({
  description:
    "Return the frozen instrumentation channel snapshot and the current live channel metadata.",
  inputSchema: z.object({}),
  execute() {
    return {
      frozen: globalThis.__eveInstrumentationSnapshot,
      live: globalThis.__eveLiveChannelMetadata,
    };
  },
});
