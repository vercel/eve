import { defineChannel, POST } from "eve/channels";

const AUTH = {
  attributes: { source: "session-timeout-eval" },
  authenticator: "threads",
  principalId: "session-timeout-eval",
  principalType: "service",
} as const;

export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { channelAddress, params }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const session = await channelAddress(params.threadId ?? "").send(body.message ?? "", {
        auth: AUTH,
      });
      return Response.json({ sessionId: session.id });
    }),
    POST("/threads/:threadId/owner", async (_request, { channelAddress, params }) => {
      const session = await channelAddress(params.threadId ?? "").resolveSession();
      return Response.json({ sessionId: session?.id ?? null });
    }),
  ],
});
