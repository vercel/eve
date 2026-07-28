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
 * and reset routes act through public channel helpers without knowing the
 * runtime session id.
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
    POST("/threads/:threadId/new", async (_request, { params, reset }) => {
      const result = await reset({
        continuationToken: params.threadId ?? "",
        reason: "E2E user requested /new",
      });
      return Response.json({ acknowledgement: "Started a new conversation.", ...result });
    }),
    POST("/threads/:threadId/owner", async (_request, { params, resolveActiveSession }) => {
      const owner = await resolveActiveSession({ continuationToken: params.threadId ?? "" });
      return Response.json({ sessionId: owner?.sessionId ?? null });
    }),
  ],
});
