import { defineChannel, POST } from "#public/definitions/channel.js";

export default defineChannel<{ lastSender: string }>({
  state: { lastSender: "" },
  routes: [
    POST("/message", async (request, { from }) => {
      const body = (await request.json()) as { message: string; userId?: string };
      await from(`conversation:${body.userId ?? "anonymous"}`).send(body.message, {
        auth: null,
        state: { lastSender: body.userId ?? "anonymous" },
      });
      return new Response("ok");
    }),
  ],
});
