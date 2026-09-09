import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/continue/:sessionId", async (_request, { attachSession, params }) => {
      const result = await attachSession(params.sessionId!).send("Continue.", { auth: null });
      return Response.json({ accepted: result.status === "accepted" });
    }),
  ],
});
