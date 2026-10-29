import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic((ctx) => {
  const groups = ctx.session.auth.current?.attributes.groups;
  if (!Array.isArray(groups) || !groups.includes("hr")) return null;
  return defineTool({
    description: "Get the payroll report for a month like 2026-01.",
    inputSchema: z.object({ month: z.string() }),
    async execute({ month }) {
      return { month };
    },
  });
});
