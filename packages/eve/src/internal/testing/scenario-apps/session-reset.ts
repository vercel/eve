import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

/** Vercel deployment fixture for continuation-token session reset behavior. */
export const SESSION_RESET_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4-mini" });
`,
    "agent/channels/threads.ts": `import { defineChannel, POST } from "eve/channels";

const AUTH = {
  attributes: { source: "session-reset-vercel-test" },
  authenticator: "session-reset-vercel-test",
  principalId: "session-reset-vercel-test",
  principalType: "service",
};

export default defineChannel({
  routes: [
    POST("/session-reset/:threadId/messages", async (request, { channelAddress, params }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const session = await channelAddress(params.threadId ?? "").send(
        body.message ?? "Reply with hello.", {
        auth: AUTH,
      });
      return Response.json({ sessionId: session.id });
    }),
    POST("/session-reset/:threadId/owner", async (_request, { channelAddress, params }) => {
      const owner = await channelAddress(params.threadId ?? "").resolveSession();
      return Response.json({ sessionId: owner?.id ?? null });
    }),
    POST("/session-reset/:threadId/new", async (_request, { channelAddress, params }) => {
      return Response.json(
        await channelAddress(params.threadId ?? "").reset({
          reason: "Vercel session reset integration test",
        }),
      );
    }),
  ],
});
`,
    "agent/instructions.md": "You are a concise test assistant.\n",
  },
  name: "session-reset",
};
