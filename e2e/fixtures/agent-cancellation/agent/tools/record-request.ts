import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description:
    "Records a request marker with the current authenticated actor. Call only when asked to record a request.",
  inputSchema: z.object({ marker: z.string() }),
  approval: never(),
  execute({ marker }, ctx) {
    return `request=${marker};actor=${ctx.session.auth.current?.principalId ?? "anonymous"}`;
  },
});
