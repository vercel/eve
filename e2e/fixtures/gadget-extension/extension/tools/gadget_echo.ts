import slugify from "slugify";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Echo with gadget. Returns a deterministic fixture result. Call when asked to echo.",
  inputSchema: z.object({ message: z.string() }),
  async execute({ message }) {
    return { message, reply: `gadget-reply:${slugify(message)}` };
  },
});
