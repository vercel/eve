import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 46 route handlers had no `invokeTool` arg; epoch 47 adds it.
export default defineChannel({
  routes: [
    GET("/status/:sessionId", async (_request, { attachSession, describe, params, requestIp }) => {
      const { tools } = await describe();
      await attachSession(params.sessionId!).cancel();
      return Response.json({ requestIp, tools: tools.length });
    }),
  ],
});
