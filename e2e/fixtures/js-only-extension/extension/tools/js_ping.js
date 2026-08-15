import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Ping the JavaScript-only extension. Returns its deterministic fixture token. Call when asked to ping the JavaScript extension.",
  inputSchema: z.object({}),
  async execute() {
    return { reply: "js-only-extension-dist-ok-4N7Q" };
  },
});
