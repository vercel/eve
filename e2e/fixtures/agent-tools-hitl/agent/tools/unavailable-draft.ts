import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Fail with a known, recoverable fixture error.",
  inputSchema: z.object({}),
  async execute(): Promise<never> {
    throw new Error("The draft store is unavailable.");
  },
});
