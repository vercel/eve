import { Client } from "eve/client";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Create a session on this fixture and return its structured result.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const deploymentHost = process.env.VERCEL_URL;
    const host = deploymentHost ? `https://${deploymentHost}` : process.env.WORKFLOW_LOCAL_BASE_URL;
    if (!host) throw new Error("The fixture's own server URL is unavailable.");
    const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(120_000)]);
    const client = new Client({
      host,
      redirect: "error",
      headers: (): Record<string, string> => {
        const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
        return deploymentHost && bypass ? { "x-vercel-protection-bypass": bypass } : {};
      },
    });
    const { response } = await client.sessions.create({
      message: "Return the structured answer client-recursion-ok.",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string", const: "client-recursion-ok" } },
        required: ["answer"],
        additionalProperties: false,
      },
      signal,
    });
    const result = await response.result();
    signal.throwIfAborted();
    return { data: result.data, status: result.status };
  },
});
