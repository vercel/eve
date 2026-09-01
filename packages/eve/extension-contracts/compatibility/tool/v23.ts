import { z } from "zod";

import { defineTool, toolOutput } from "#public/tools/index.js";

export default defineTool({
  description: "Look up a service and project a short summary for the model.",
  inputSchema: z.object({ service: z.string() }),
  execute({ service }, ctx) {
    return { callId: ctx.callId, service, status: "healthy" };
  },
  toModelOutput: (output) => toolOutput.text(`${output.service} is ${output.status}`),
});
