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
    POST("/session-reset/:threadId/messages", async (request, { params, send }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const session = await send(params.threadId ?? "", {
        auth: AUTH,
        message: body.message ?? "Reply with hello.",
      });
      return Response.json({ sessionId: session.id });
    }),
    POST("/session-reset/:threadId/owner", async (_request, { params, resolveSession }) => {
      const owner = await resolveSession(params.threadId ?? "");
      return Response.json({ sessionId: owner?.id ?? null });
    }),
    POST("/session-reset/:threadId/new", async (_request, { params, reset }) => {
      return Response.json(
        await reset(params.threadId ?? "", {
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
