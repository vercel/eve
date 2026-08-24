import { defineTool } from "eve/tools";
import { z } from "zod";

const PROBES = {
  first: { delayMs: 10_000, result: "WAKE-MECHANISM" },
  second: { delayMs: 40_000, result: "CHANNEL-DELIVERY" },
  third: { delayMs: 70_000, result: "REPORTING-POLICY" },
} as const;

export default defineTool({
  description: "Complete one requested reporting probe after its configured delay.",
  inputSchema: z.strictObject({
    check: z.enum(["first", "second", "third"]),
  }),
  async execute({ check }) {
    const probe = PROBES[check];
    await new Promise((resolve) => setTimeout(resolve, probe.delayMs));
    return { result: probe.result };
  },
});
