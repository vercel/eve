import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** HITL gate: parks the turn on an approval before returning its marker. */
export default defineTool({
  description: "Release the gate. Requires human approval before it runs.",
  inputSchema: z.object({}),
  approval: always(),
  async execute() {
    return { marker: "GATE-RELEASED-7Q4Z" };
  },
});
