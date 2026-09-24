import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 34 Session.cancel accepted only turnId; epoch 35 adds taskId and tasks.
export default defineChannel({
  routes: [
    POST("/stop/:sessionId", async (request, { attachSession, params }) => {
      const { turnId } = (await request.json()) as { turnId?: string };
      const result = await attachSession(params.sessionId!).cancel(
        turnId === undefined ? undefined : { turnId },
      );
      return Response.json({ status: result.status });
    }),
  ],
});
