import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Marks the assistant-final resumption fixture as executed.",
  inputSchema: z.object({ marker: z.string() }),
  approval: always(),
  async execute({ marker }) {
    return { executed: true, marker };
  },
});
