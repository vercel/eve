import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { handOff } from "../lib/hand-off";

/** Hands the conversation to the target channel from a workflow tool's step. */
export default defineWorkflowTool({
  description: "Hand this conversation to the target channel durably.",
  inputSchema: z.strictObject({ sessionRef: z.string() }),
  execute: handOff,
});
