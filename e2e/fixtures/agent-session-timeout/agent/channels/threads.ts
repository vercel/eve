import { defineChannel, POST } from "eve/channels";

const AUTH = {
  attributes: { source: "session-timeout-eval" },
  authenticator: "threads",
  principalId: "session-timeout-eval",
  principalType: "service",
} as const;

export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { from, params }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const session = await from(params.threadId ?? "").send(body.message ?? "", {
        auth: AUTH,
      });
      return Response.json({ sessionId: session.id });
    }),
    POST("/threads/:threadId/owner", async (_request, { params, resolveSession }) => {
      const session = await resolveSession(params.threadId ?? "");
      return Response.json({ sessionId: session?.id ?? null });
    }),
  ],
});
