import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

const PROBES = { first: "oranges", second: "pears", third: "apples" } as const;

export default defineTool({
  description: "Look up a sample warehouse's inventory item after Alice approves the lookup.",
  inputSchema: z.strictObject({
    check: z.enum(["first", "second", "third"]),
  }),
  approval: once(),
  execute: ({ check }) => ({ result: PROBES[check] }),
});
