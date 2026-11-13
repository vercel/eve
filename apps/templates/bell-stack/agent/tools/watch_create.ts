import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { monitors } from "../../server/monitors/service";
import { watchIdentity, safeWatch, watchDestination } from "../lib/monitors";
import { queryInput, frequencyInput } from "../../server/monitors/config";

export default defineTool({
  description: "Create a public-web watch with Parallel lite. Frequency defaults to daily; whole hours/days/weeks from 1h to 30d are supported. Faster checks increase scheduled usage. Only create when the user asks for ongoing monitoring. Never include secrets or private browser content. Watches continue until stopped; list existing watches before retrying an uncertain creation.",
  inputSchema: z.object({ query: queryInput, frequency: frequencyInput.default("1d") }),
  execute: (input, ctx) => safeWatch(() => {
    watchIdentity(ctx);
    const service = monitors();
    return service.create(watchIdentity(ctx), watchDestination(ctx), JSON.stringify([ctx.session.id, ctx.callId]), input.query, input.frequency);
  }),
  toModelOutput: output => toolOutput.json(output),
});
