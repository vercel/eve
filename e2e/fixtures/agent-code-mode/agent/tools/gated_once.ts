import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

/** Approved once per session, so a program prompts for it a single time. */
export default defineTool({
  approval: once(),
  description: "An approval-gated tool that code_mode asks about once per session.",
  inputSchema: z.strictObject({}),
  execute: () => "GATED-ONCE",
});
