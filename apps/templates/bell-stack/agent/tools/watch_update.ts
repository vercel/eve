import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { monitors } from "../../server/monitors/service";
import { frequencyInput } from "../../server/monitors/config";
import { watchIdentity, safeWatch } from "../lib/monitors";

export default defineTool({
  description: "Change an existing active watch's research frequency, from 1h to 30d. Faster checks increase scheduled usage. A pending_frequency is not confirmed; list watches to check completion. Does not create a replacement monitor.",
  inputSchema: z.object({ id: z.string().uuid(), frequency: frequencyInput }),
  execute: (input, ctx) => safeWatch(() => {
    const owner = watchIdentity(ctx);
    return monitors().update(owner, input.id, input.frequency);
  }),
  toModelOutput: output => toolOutput.json(output),
});
