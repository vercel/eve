import { defineChannel, POST } from "eve/channels";

const AUTH = {
  attributes: { source: "cancellation-eval" },
  authenticator: "threads",
  principalId: "cancellation-eval",
  principalType: "service",
} as const;

/**
 * Chat-style channel for continuation-addressed session-control evals.
 *
 * Messages address a thread by channel-local continuation token. The stop
 * and session-control routes act through channel operations without
 * knowing the runtime session id.
 */
export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { from, params }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const session = await from(params.threadId ?? "").send(body.message ?? "", {
        auth: AUTH,
      });
      return Response.json({ ok: true, sessionId: session.id });
    }),
    POST("/threads/:threadId/stop", async (_request, { from, params }) => {
      const result = await from(params.threadId ?? "").cancel();
      return Response.json(result);
    }),
    POST("/threads/:threadId/new", async (_request, { from, params }) => {
      const result = await from(params.threadId ?? "").reset({
        reason: "E2E user requested /new",
      });
      return Response.json({ acknowledgement: "Started a new conversation.", ...result });
    }),
    POST("/threads/:threadId/compact", async (_request, { from, params }) => {
      const result = await from(params.threadId ?? "").compact();
      return Response.json(result);
    }),
    POST("/threads/:threadId/clear", async (_request, { from, params }) => {
      const result = await from(params.threadId ?? "").clear();
      return Response.json(result);
    }),
    POST("/threads/:threadId/owner", async (_request, { params, resolveSession }) => {
      const session = await resolveSession(params.threadId ?? "");
      return Response.json({ sessionId: session?.id ?? null });
    }),
  ],
});
