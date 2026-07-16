import { defineChannel, POST } from "eve/channels";

const AUTH = {
  attributes: { source: "cancellation-eval" },
  authenticator: "threads",
  principalId: "cancellation-eval",
  principalType: "service",
} as const;

/**
 * Chat-style channel for the continuation-addressed cancellation eval.
 *
 * Messages address a thread by channel-local continuation token. The stop
 * route cancels the thread's active turn through the public `cancel` route
 * helper without knowing the runtime session id.
 */
export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { params, send }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const session = await send(body.message ?? "", {
        auth: AUTH,
        continuationToken: params.threadId ?? "",
      });
      return Response.json({ ok: true, sessionId: session.id });
    }),
    POST("/threads/:threadId/stop", async (_request, { params, cancel }) => {
      const result = await cancel({ continuationToken: params.threadId ?? "" });
      return Response.json(result);
    }),
  ],
});
