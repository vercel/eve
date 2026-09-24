import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 35 Session.send took no operationId; epoch 36 adds it for replay-stable sends.
export default defineChannel({
  routes: [
    POST("/relay/:sessionId", async (request, { attachSession, params }) => {
      const { message } = (await request.json()) as { message: string };
      const result = await attachSession(params.sessionId!).send(message, {
        auth: null,
        turnPolicy: "queue",
      });
      return Response.json({ status: result.status });
    }),
  ],
});
