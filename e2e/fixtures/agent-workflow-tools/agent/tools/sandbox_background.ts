import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { probeSandbox } from "../lib/sandbox-probe.ts";

export default defineWorkflowTool({
  description: "Write and read a sandbox file across durable steps.",
  execution: "background",
  inputSchema: z.strictObject({ service: z.string() }),
  execute: probeSandbox,
});
