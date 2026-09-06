import { defineTool } from "eve/tools";
import { z } from "zod";

const PROBES = {
  first: { delayMs: 10_000, result: "oranges" },
  second: { delayMs: 40_000, result: "pears" },
  third: { delayMs: 70_000, result: "apples" },
} as const;

export default defineTool({
  description: "Look up the inventory item at one sample warehouse after its configured delay.",
  inputSchema: z.strictObject({
    check: z.enum(["first", "second", "third"]),
  }),
  async execute({ check }) {
    const probe = PROBES[check];
    await new Promise((resolve) => setTimeout(resolve, probe.delayMs));
    return { result: probe.result };
  },
});
