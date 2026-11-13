import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { monitors } from "../../server/monitors/service";
import { watchIdentity, safeWatch } from "../lib/monitors";

export default defineTool({
  description: "Permanently stop one of this sender's watches. Local alerts stop immediately; cancel_pending means upstream cancellation is still pending and billing may continue.",
  inputSchema: z.object({ id: z.string().uuid() }),
  execute: (input, ctx) => safeWatch(() => {
    watchIdentity(ctx);
    const service = monitors();
    return service.stop(watchIdentity(ctx), input.id);
  }),
  toModelOutput: output => toolOutput.json(output),
});
