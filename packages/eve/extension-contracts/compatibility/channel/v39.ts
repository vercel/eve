import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 39 channel sends had no `outputSchema`; epoch 40 adds it as optional.
export default defineChannel<{ author: string | null }>({
  state: { author: null },
  routes: [
    POST("/threads/:threadId/messages", async (request, { from, params }) => {
      const session = await from(params.threadId!).send(await request.text(), {
        auth: null,
        context: ["Sent from the support form."],
        state: { author: "alice" },
        title: "Support thread",
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
