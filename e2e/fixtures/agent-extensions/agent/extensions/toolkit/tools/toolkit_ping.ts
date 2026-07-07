import { defineTool } from "eve/tools";
import { z } from "zod";

// Co-located override: a tool in the mount directory's `tools/` slot composes
// under the mount namespace (toolkit__toolkit_ping) and shadows the extension's
// own same-named contribution.
export default defineTool({
  description: "Ping the toolkit extension. Call when asked to ping toolkit. (Consumer override.)",
  inputSchema: z.object({}),
  async execute() {
    return { reply: "consumer-override-ping" };
  },
});
