import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** Approval-gated: direct calls and program calls both ask the person first. */
export default defineTool({
  approval: always(),
  description: "An approval-gated tool that asks the person before every call.",
  inputSchema: z.strictObject({}),
  execute: () => "GATED",
});
