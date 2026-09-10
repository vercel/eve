import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

/**
 * Authored workflow tool that a program can await. Its body runs inline
 * inside the code_mode run, so the step below nests into that run.
 */
export default defineWorkflowTool({
  description: "Plan a deploy durably and return the plan.",
  inputSchema: z.strictObject({ service: z.string() }),
  async *execute({ service }) {
    "use workflow";

    yield "planning";
    const plan = await planStep(service);
    return { plan, service };
  },
});

async function planStep(service: string): Promise<string> {
  "use step";
  return `PLAN:${service}`;
}
