import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 45 route handlers had no `describe` or `invokeTool` args; epoch 46 adds both.
export default defineChannel({
  routes: [
    GET("/status/:sessionId", async (_request, { attachSession, params, requestIp }) => {
      await attachSession(params.sessionId!).cancel();
      return Response.json({ requestIp });
    }),
  ],
});
