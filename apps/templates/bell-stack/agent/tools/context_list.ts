import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { listAgentContexts } from "../../server/browser/agent-contexts";

export default defineTool({
  description:
    "List reusable Browserbase Contexts that Bell can select for a later browser task. Context IDs are safe metadata, not credentials.",
  inputSchema: z.object({}),
  async execute() {
    const contexts = await listAgentContexts();
    return {
      contexts: contexts.map(({ id, name, selected, writerActive }) => ({
        id,
        name,
        selected,
        writerActive,
      })),
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
