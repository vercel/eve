import { Client } from "eve/client";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => {
      // Other runtime evals require a single model step without tool calls.
      const requested = ctx.messages.some((message) => {
        if (message.role !== "user") return false;
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
        return text.startsWith("Call call_child ");
      });
      if (!requested) return null;

      return defineTool({
        description: "Create a session on this fixture and return its structured result.",
        inputSchema: z.object({}),
        async execute(_input, ctx) {
          const deploymentHost = process.env.VERCEL_URL;
          const host = deploymentHost
            ? `https://${deploymentHost}`
            : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000");
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
            message: 'Call final_output exactly once with {"answer":"client-recursion-ok"}.',
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
          return { data: result.data, status: result.status, sessionId: result.sessionId };
        },
      });
    },
  },
});
