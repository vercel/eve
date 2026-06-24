import { defineChannel, POST } from "eve/channels";
import target from "./target.js";

/**
 * Exercises the cross-channel `args.receive(channel, …)` path: the
 * webhook handler does not start a session of its own; it hands the
 * message off to the target channel and returns the new session id so
 * the smoke test client can stream the resulting turn.
 */
export default defineChannel({
  routes: [
    POST("/webhook", async (req, args) => {
      const body = (await req.json().catch(() => ({}))) as {
        message?: string;
        sessionRef?: string;
        structured?: boolean;
      };
      const options = {
        message: body.message ?? "Reply with the single word: hello.",
        target: { sessionRef: body.sessionRef ?? crypto.randomUUID() },
        auth: {
          attributes: { source: "smoke-test" },
          authenticator: "webhook",
          principalId: "smoke-test",
          principalType: "service",
        },
      } as const;
      const session = body.structured
        ? await args.receive(target, {
            ...options,
            outputSchema: {
              additionalProperties: false,
              properties: {
                count: { type: "integer" },
                title: { type: "string" },
              },
              required: ["title", "count"],
              type: "object",
            },
          })
        : await args.receive(target, options);
      return Response.json({ ok: true, sessionId: session.id });
    }),
  ],
});
