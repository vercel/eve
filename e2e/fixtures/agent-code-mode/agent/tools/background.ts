import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "An ordinary background tool that must stay outside code mode.",
  execution: "background",
  inputSchema: z.strictObject({}),
  execute: async () => "BACKGROUND-DONE",
});
