import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 45 route handlers had no `describe` arg; epoch 46 adds it.
export default defineChannel({
  routes: [
    GET("/status/:sessionId", async (_request, { attachSession, params, requestIp }) => {
      await attachSession(params.sessionId!).cancel();
      return Response.json({ requestIp });
    }),
  ],
});
