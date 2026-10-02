import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: always(),
  description: "Publish a notice on the kennel's front-desk board. Asks before every post.",
  inputSchema: z.object({ notice: z.string() }),
  async execute({ notice }, ctx) {
    return { by: ctx.session.auth.current?.principalId ?? null, published: notice };
  },
});
