import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Remote-child approval gate that reports the resumed HTTP principal.",
  inputSchema: z.object({ marker: z.literal("C8") }),
  approval: once(),
  async execute(_input, ctx) {
    const current = ctx.session.auth.current;
    const principal = current === null ? "none" : `${current.principalType}:${current.principalId}`;
    return { marker: `C8-REMOTE-PRINCIPAL:${principal}` };
  },
});
