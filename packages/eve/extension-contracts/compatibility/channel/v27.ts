import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/continue/:sessionId", async (_request, { attachSession, params }) => {
      const result = await attachSession(params.sessionId!).send("Continue.", {
        auth: null,
        turnPolicy: "queue",
      });
      return Response.json({ status: result.status });
    }),
  ],
});
