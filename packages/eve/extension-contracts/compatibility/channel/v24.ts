import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/continue/:sessionId", async (_request, { attachSession, params }) => {
      const result = await attachSession(params.sessionId!).send("Continue.", {
        auth: null,
        turnPolicy: "queue",
      });
      if (result.status === "session_not_active") {
        return Response.json({ accepted: false }, { status: 409 });
      }
      return Response.json({ sessionId: result.sessionId, deliveryId: result.deliveryId });
    }),
  ],
});
