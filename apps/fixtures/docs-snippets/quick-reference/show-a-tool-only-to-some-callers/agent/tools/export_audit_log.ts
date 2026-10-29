import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic((ctx) => {
  const groups = ctx.session.auth.current?.attributes.groups;
  if (!Array.isArray(groups) || !groups.includes("admin")) return null;
  return defineTool({
    description: "Export the audit log for a date range.",
    inputSchema: z.object({ from: z.string().date(), to: z.string().date() }),
    async execute({ from, to }) {
      return { from, to, entries: [] };
    },
  });
});
