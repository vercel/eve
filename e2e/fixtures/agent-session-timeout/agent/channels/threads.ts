import { defineChannel, POST } from "eve/channels";

const AUTH = {
  attributes: { source: "session-timeout-eval" },
  authenticator: "threads",
  principalId: "session-timeout-eval",
  principalType: "service",
} as const;

export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { params, send }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const session = await send(body.message ?? "", {
        auth: AUTH,
        continuationToken: params.threadId ?? "",
      });
      return Response.json({ sessionId: session.id });
    }),
    POST("/threads/:threadId/owner", async (_request, { params, resolveActiveSession }) => {
      const owner = await resolveActiveSession({ continuationToken: params.threadId ?? "" });
      return Response.json({ sessionId: owner?.sessionId ?? null });
    }),
  ],
});
