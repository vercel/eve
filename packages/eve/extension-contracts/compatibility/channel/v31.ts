// Existing callbacks remain valid when the runtime supplies session.context.
import { defineChannel, POST } from "#public/channels/index.js";
export default defineChannel({
  routes: [
    POST("/continue/:sessionId", async (_, { attachSession, params }) => {
      const result = await attachSession(params.sessionId!).send("Continue.", { auth: null });
      return Response.json(result);
    }),
  ],
});
