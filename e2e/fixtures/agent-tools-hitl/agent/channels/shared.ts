import { defineChannel, POST } from "eve/channels";

/**
 * A shared thread: teammates address the same thread, so a message from
 * another person joins whatever turn is running instead of starting a new one.
 * The channel keeps that turn's caller; `principalPolicy` is decided here, not
 * by the request body.
 */
export default defineChannel({
  principalPolicy: "keep",
  routes: [
    POST("/shared/:threadId/messages", async (request, { from, params }) => {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const principalId = request.headers.get("x-eve-fixture-user") ?? "e2e-approval-responder";
      const session = await from(params.threadId ?? "").send(body.message ?? "", {
        auth: {
          attributes: {
            fixture: "authorized-response",
            flag: request.headers.get("x-eve-fixture-flag") ?? "none",
            // Fixed so the fixture's scripted hitl model drives this channel.
            model: "hitl",
          },
          authenticator: "e2e-fixture",
          issuer: "e2e",
          principalId,
          principalType: "user",
          subject: principalId,
        },
      });
      return Response.json({ ok: true, sessionId: session.sessionId });
    }),
  ],
});
