import { defineChannel, POST } from "eve/channels";
import target from "./target";

/**
 * Exercises the cross-channel `ctx.to(channel, target).send(...)` path: the
 * webhook handler does not start a session of its own; it hands the
 * message off to the target channel and returns the new session id so
 * the smoke test client can stream the resulting turn.
 */
export default defineChannel({
  routes: [
    POST("/webhook", async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as {
        message?: string;
        sessionRef?: string;
      };
      const session = await ctx
        .to(target, { sessionRef: body.sessionRef ?? crypto.randomUUID() })
        .send(body.message ?? "Reply with the single word: hello.", {
          auth: {
            attributes: { source: "smoke-test" },
            authenticator: "webhook",
            principalId: "smoke-test",
            principalType: "service",
          },
        });
      return Response.json({ ok: true, sessionId: session.id });
    }),
  ],
});
