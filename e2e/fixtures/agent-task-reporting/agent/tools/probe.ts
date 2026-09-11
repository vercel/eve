import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

const PROBES = { first: "oranges", second: "pears", third: "apples" } as const;

export default defineTool({
  description: "Look up the warehouse inventory item for a checklist entry.",
  inputSchema: z.strictObject({
    check: z.enum(["first", "second", "third"]),
  }),
  approval: once(),
  execute: ({ check }) => ({ result: PROBES[check] }),
});
