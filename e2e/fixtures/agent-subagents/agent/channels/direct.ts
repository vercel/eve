import { defineChannel, POST } from "eve/channels";

export default defineChannel({
  routes: [
    POST("/direct-agent", async (request, { from }) => {
      const body = (await request.json()) as {
        agent: string;
        message: string;
        threadId: string;
      };
      const session = await from(body.threadId).send(body.message, {
        agent: body.agent,
        auth: null,
      });
      return Response.json(
        { ok: true, sessionId: session.id, status: "accepted" },
        { status: 202 },
      );
    }),
    POST("/direct-agent/owner", async (request, { resolveSession }) => {
      const body = (await request.json()) as { address: string };
      const session = await resolveSession(body.address);
      return Response.json({ sessionId: session?.id ?? null });
    }),
  ],
  events: {
    "message.completed"(_event, channel, ctx) {
      channel.continuation?.rekey(`handled:${ctx.session.id}`);
    },
  },
});
