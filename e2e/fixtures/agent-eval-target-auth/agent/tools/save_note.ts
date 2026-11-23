import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Save a note on a support ticket. Requires approval.",
  inputSchema: z.object({ id: z.string(), note: z.string() }),
  approval: always(),
  execute: ({ id }) => ({ saved: true, id }),
});
