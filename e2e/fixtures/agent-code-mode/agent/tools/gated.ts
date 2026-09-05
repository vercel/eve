import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** Approval-gated, so it must stay a direct model tool rather than enter code_mode. */
export default defineTool({
  approval: always(),
  description: "An approval-gated tool that code_mode must not claim.",
  inputSchema: z.strictObject({}),
  execute: () => "GATED",
});
