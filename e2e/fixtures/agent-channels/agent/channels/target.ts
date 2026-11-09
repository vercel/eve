import { defineChannel, POST } from "eve/channels";

/**
 * Receive-only target channel for the cross-channel handoff smoke
 * test. The POST route exists only to satisfy the channel manifest's
 * "every channel mounts at least one route" requirement.
 */
export default defineChannel({
  audience({ caller }) {
    return caller.type === "principal" && caller.principal.kind === "service"
      ? "private"
      : "unknown";
  },
  routes: [
    POST("/target", async () => new Response("ok")),
    POST("/deliveries/:conversationId", async (request, { from, params }) => {
      const body = (await request.json()) as { message: string; idempotencyKey?: string };
      const session = await from(params.conversationId).send(body.message, {
        auth: null,
        idempotencyKey: body.idempotencyKey,
        turnPolicy: "queue",
      });
      return Response.json({ sessionId: session.sessionId });
    }),
  ],
  async receive({ message, target, ...send }, { from }) {
    const sessionRef = typeof target.sessionRef === "string" ? target.sessionRef : "default";
    return from(`target:${sessionRef}`).send(message, send);
  },
});
