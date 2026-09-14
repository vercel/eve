import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Return a marker after explicit approval.",
  inputSchema: z.object({ marker: z.string() }),
  approval: always(),
  execute: ({ marker }) => ({ marker }),
});
